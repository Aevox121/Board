/**
 * BoardRuntime —— 单个 `.board` 目录的运行态装配（M4 工作包3 中继服务器）。
 *
 * 把一份 .board 所需的全部服务端状态打包成一个 runtime 对象：
 *  - Y.Doc 房间 + ws 连接
 *  - chokidar 监听 + 防抖 reconcile
 *  - SSE 广播器 + 事件日志 + 在场注册表 + 任务存储
 *  - HttpDeps（HTTP 路由所需的全部依赖）
 *
 * 多 board 模式下一台 server 同时持有多份 runtime（按 boardId 索引），
 * 互不干扰：一个 board 的文件变更 / SSE 广播 / 事件日志只发给该 board 的客户端。
 *
 * 与 index.ts 旧版「全局变量装配」相比唯一变化：作用域改成函数闭包，
 * 行为完全等价。
 */
import {
  diffScenes,
  newShareToken,
  type BoardEventType,
  type BoardMeta,
  type BoardScene,
} from '@board/core';
import { listBoardFiles, loadBoard, saveBoard } from '@board/core/node';
import { createEventLog } from './events.js';
import type { HttpDeps } from './http.js';
import {
  createOpLog,
  OP_CHANGE,
  OP_RECONCILE,
  type OpLog,
} from './oplog.js';
import { createPresenceHub } from './presence.js';
import { runReconcile } from './reconcile.js';
import { createSseHub } from './sse.js';
import { createTaskStore } from './tasks.js';
import { startWatcher, type BoardWatcher } from './watcher.js';
import { createYjsRoom, type YjsRoom } from './yjs-room.js';

/** 文件系统变更触发 reconcile 的固定操作者身份（系统）。 */
const SYSTEM_ACTOR = 'u_system';
/** reconcile 防抖窗口（毫秒）。 */
const RECONCILE_DEBOUNCE_MS = 200;

export interface BoardRuntime {
  /** URL 与日志显示用的 board 标识（一般是 dir basename 去掉 .board 后缀）。 */
  boardId: string;
  /** .board 目录绝对路径。 */
  dir: string;
  /** HTTP 路由依赖。 */
  deps: HttpDeps;
  /** Yjs 房间 —— ws upgrade 时拿去 handleWsConnection。 */
  room: YjsRoom;
  /** 关停 —— flush 落盘 / 清理 watcher / 关 SSE / 关 room。 */
  close(): Promise<void>;
}

export interface CreateBoardRuntimeOptions {
  boardId: string;
  dir: string;
}

export async function createBoardRuntime(
  opts: CreateBoardRuntimeOptions,
): Promise<BoardRuntime> {
  const { boardId, dir } = opts;

  // 启动前先验证白板可读；失败则抛出，调用方决定继续 / 退出。
  let currentMeta: BoardMeta;
  let initialScene: BoardScene;
  try {
    const handle = await loadBoard(dir);
    currentMeta = handle.meta;
    initialScene = handle.scene;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`无法打开白板 ${dir}: ${msg}`);
  }

  // 老 board 没 shareToken（在该字段引入前创建的）—— 自动补一个并落盘，
  // 让 BOARD_REQUIRE_TOKEN=true 部署对历史 board 也直接可用。
  if (!currentMeta.shareToken) {
    currentMeta = { ...currentMeta, shareToken: newShareToken() };
    try {
      await saveBoard(dir, currentMeta, initialScene);
      console.log(`[board-server:${boardId}] 已补生成 shareToken 并写回 meta.json`);
    } catch (err) {
      console.error(`[board-server:${boardId}] 写 shareToken 失败:`, err);
      // 不阻断启动 —— 内存里的 token 仍可用，下次保存时会顺带落盘
    }
  }

  // Y.Doc 房间 —— 启动期由 board.json 构出运行态权威源，节流投影回 board.json。
  const room = createYjsRoom({
    dir,
    initialScene,
    saveScene: async (scene) => {
      await saveBoard(dir, currentMeta, scene);
    },
  });

  // SSE 广播器：board 变化时向所有该 board 的连接推送。
  const sse = createSseHub();
  // Agent 任务运行时存储（Pencil 式过程可视化）。
  const tasks = await createTaskStore(dir);
  // 事件日志。
  const events = createEventLog();
  const opLog: OpLog = await createOpLog(dir);
  // 在场注册表（光标）。
  const presence = createPresenceHub();
  const presencePrune = setInterval(() => {
    for (const id of presence.prune()) {
      const leaveFrame = { type: 'presence-leave', clientId: id };
      sse.broadcast(leaveFrame);
    }
  }, 5000);
  presencePrune.unref();

  // 启动 reconcile：files/ 现状 → Y.Doc。已有文件不算「新增」（不发事件）。
  try {
    const result = await runReconcile({
      dir,
      scene: room.getScene(),
      previewLimitMB: currentMeta.settings.previewSizeLimitMB,
      actor: SYSTEM_ACTOR,
    });
    if (result.changed) {
      room.mutate(SYSTEM_ACTOR, () => result.scene);
    }
  } catch (err) {
    console.error(`[board-server:${boardId}] 启动 reconcile 失败:`, err);
  }

  // 事件 diff 的基线场景 —— 启动 reconcile 之后的场景。
  let lastScene: BoardScene = room.getScene();

  /**
   * 比对 Y.Doc 当前场景与基线，产事件流事件并广播；同时返回事件计数摘要
   * 用于 oplog 写入。
   */
  async function syncSceneEvents(actor: string): Promise<{ count: number; types: string[] }> {
    try {
      const cur = room.getScene();
      const drafts = diffScenes(lastScene, cur, actor);
      lastScene = cur;
      for (const evt of events.append(drafts)) sse.broadcast(evt);
      return {
        count: drafts.length,
        types: Array.from(new Set(drafts.map((d) => d.type))),
      };
    } catch (err) {
      console.error(`[board-server:${boardId}] 记录变更事件失败:`, err);
      return { count: 0, types: [] };
    }
  }

  // 串行化执行 —— 并发写时若两次 diff 撞同一基线会重发，用 Promise 链强制顺序。
  let recordChain: Promise<void> = Promise.resolve();
  function serialize(fn: () => Promise<void>): Promise<void> {
    recordChain = recordChain.then(fn);
    return recordChain;
  }

  function recordChange(actor: string): Promise<void> {
    return serialize(async () => {
      const summary = await syncSceneEvents(actor);
      // 写 oplog —— 只在确有变更时落盘，跳过空 diff 的「无操作」回调。
      if (summary.count > 0) {
        await opLog.append({
          actor,
          op: actor === SYSTEM_ACTOR ? OP_RECONCILE : OP_CHANGE,
          details: { count: summary.count, types: summary.types },
        });
      }
      sse.broadcast({ type: 'board-changed' });
    });
  }

  function emitEvent(
    type: BoardEventType,
    actor: string,
    payload: Record<string, unknown>,
  ): void {
    for (const evt of events.append([{ type, actor, payload }])) {
      sse.broadcast(evt);
    }
  }

  async function reconcileOnce(reason: string): Promise<void> {
    try {
      const result = await runReconcile({
        dir,
        scene: room.getScene(),
        previewLimitMB: currentMeta.settings.previewSizeLimitMB,
        actor: SYSTEM_ACTOR,
      });
      // 把 watcher 的内存集合同步到 reconcile 刚扫到的磁盘状态 —— 消除
      // chokidar 轮询间隔（默认 250ms）内主动写文件（如 /api/files/upload）
      // 与 getFiles() 之间的窗口期：否则上传后 watcher 还没轮询到新文件，
      // getFiles() 返旧列表，web 端 missingFileIds 误把刚上传的文件标
      // 为缺失（R6）。
      watcher?.sync(result.diskFiles);
      if (result.changed) {
        console.log(
          `[board-server:${boardId}] reconcile(${reason}): 新增 ${result.added.length}` +
            ` / 移动 ${result.moved.length}` +
            ` / 缺失 ${result.missing.length} 个 file 元素`,
        );
        room.mutate(SYSTEM_ACTOR, () => result.scene);
        await recordChange(SYSTEM_ACTOR);
      }
    } catch (err) {
      console.error(`[board-server:${boardId}] reconcile(${reason}) 失败:`, err);
    }
  }

  let debounceTimer: NodeJS.Timeout | null = null;
  function scheduleReconcile(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void reconcileOnce('watch');
    }, RECONCILE_DEBOUNCE_MS);
  }

  let initialFiles: string[] = [];
  try {
    initialFiles = await listBoardFiles(dir);
  } catch (err) {
    console.error(`[board-server:${boardId}] 扫描 files/ 失败，按空列表处理:`, err);
  }

  const watcher: BoardWatcher = startWatcher(dir, initialFiles, () => {
    scheduleReconcile();
  });

  const deps: HttpDeps = {
    dir,
    getFiles: () => watcher.getFiles(),
    sse,
    tasks,
    reconcileNow: reconcileOnce,
    events,
    presence,
    recordChange,
    emitEvent,
    opLog,
    room,
    getMeta: () => currentMeta,
    setMeta: (next) => {
      currentMeta = next;
    },
    pauseWatcher: () => watcher.pause(),
    resumeWatcher: (files) => watcher.resume(files),
  };

  async function close(): Promise<void> {
    if (debounceTimer) clearTimeout(debounceTimer);
    clearInterval(presencePrune);
    sse.closeAll();
    try {
      await room.flushToDisk();
    } catch (err) {
      console.error(`[board-server:${boardId}] flushToDisk 失败:`, err);
    }
    room.close();
    try {
      await watcher.close();
    } catch (err) {
      console.error(`[board-server:${boardId}] watcher.close 失败:`, err);
    }
  }

  return { boardId, dir, deps, room, close };
}
