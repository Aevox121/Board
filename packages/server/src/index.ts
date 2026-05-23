/**
 * Board 本地服务 — M4 装配入口
 *
 * 职责（见 PRD §4 / specs/数据模型规格.md §5.7 / §9）：
 *  - 拥有 .board 文件夹，chokidar 监听 files/ 变化
 *  - 文件 add/change/unlink 时执行 reconcile：files/ → 画布 file 元素
 *    （结果通过 yjsRoom 写入 Y.Doc，不再直接落 board.json）
 *  - 启动期读 board.json → sceneToYDoc 构 Y.Doc 作为运行态权威源
 *  - HTTP API + ws /yjs（y-protocols sync + awareness）
 *  - 节流投影 Y.Doc → board.json（人可读副本 + 崩溃恢复源）
 *
 * 安全：仅监听 127.0.0.1（PRD §12）。
 */
import { resolve } from 'node:path';
import {
  diffScenes,
  type BoardEventType,
  type BoardMeta,
  type BoardScene,
} from '@board/core';
import { listBoardFiles, loadBoard, saveBoard } from '@board/core/node';
import { WebSocketServer } from 'ws';
import { createEventLog } from './events.js';
import { createHttpServer, HOST, type HttpDeps } from './http.js';
import { createPresenceHub } from './presence.js';
import { runReconcile } from './reconcile.js';
import { createSseHub } from './sse.js';
import { createTaskStore } from './tasks.js';
import { startWatcher, type BoardWatcher } from './watcher.js';
import { createYjsRoom } from './yjs-room.js';

/** 默认监听端口，可用 BOARD_PORT 覆盖。 */
const PORT = Number(process.env.BOARD_PORT ?? 4500);

/** 文件系统变更触发 reconcile 的固定操作者身份（系统）。 */
const SYSTEM_ACTOR = 'u_system';

/** reconcile 防抖窗口（毫秒）——批量文件变更只触发一次 reconcile。 */
const RECONCILE_DEBOUNCE_MS = 200;

function printUsageAndExit(): never {
  console.error(
    [
      'Board 本地服务 — 用法:',
      '',
      '  board-server <.board 目录>',
      '  BOARD_DIR=<.board 目录> board-server',
      '',
      '可选环境变量:',
      '  BOARD_PORT   HTTP 端口（默认 4500）',
      '',
      '示例:',
      '  board-server ./boards/旅行计划.board',
    ].join('\n'),
  );
  process.exit(1);
}

function resolveBoardDir(): string {
  const fromArg = process.argv[2];
  const fromEnv = process.env.BOARD_DIR;
  const raw = fromArg ?? fromEnv;
  if (!raw || !raw.trim()) {
    printUsageAndExit();
  }
  return resolve(raw.trim());
}

async function main(): Promise<void> {
  const dir = resolveBoardDir();

  // 启动前先验证白板可读，失败则给出清晰错误并退出（不崩栈）
  let currentMeta: BoardMeta;
  let initialScene: BoardScene;
  try {
    const handle = await loadBoard(dir);
    currentMeta = handle.meta;
    initialScene = handle.scene;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[board-server] 无法打开白板 ${dir}`);
    console.error(`[board-server] 原因: ${msg}`);
    console.error('[board-server] 请确认该路径是一个有效的 .board 文件夹。');
    process.exit(1);
  }

  // M4 增量2：Y.Doc 房间 —— 启动时由 board.json 构出运行态权威源，
  // 观察器节流投影回 board.json（人可读副本 + 崩溃恢复源）。
  let savedSceneRef: BoardScene = initialScene;
  const room = createYjsRoom({
    dir,
    initialScene,
    saveScene: async (scene) => {
      await saveBoard(dir, currentMeta, scene);
      savedSceneRef = scene;
    },
  });

  // 启动期先把 SOT 切到 Y.Doc：此时 board.json 与 Y.Doc 已一致，无需立刻落盘。
  void savedSceneRef;

  // SSE 广播器：board 变化时向所有连接推送
  const sse = createSseHub();

  // Agent 任务运行时存储（Pencil 式过程可视化）—— 从 .runtime/tasks.json 恢复
  const tasks = await createTaskStore(dir);

  // 事件日志：编号 + 留存最近事件，供 board watch / board_subscribe_events 订阅
  const events = createEventLog();

  // 在场参与者注册表（拟人化光标）。定时清理超时未上报的离线条目并广播离开。
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
    console.error('[board-server] 启动 reconcile 失败:', err);
  }

  // 事件 diff 的基线场景 —— 取启动 reconcile 之后的场景。后续每次变更都与它比对。
  let lastScene: BoardScene = room.getScene();

  /** 比对 Y.Doc 当前场景与基线场景，产事件流事件并广播。 */
  async function syncSceneEvents(actor: string): Promise<void> {
    try {
      const cur = room.getScene();
      const drafts = diffScenes(lastScene, cur, actor);
      lastScene = cur;
      for (const evt of events.append(drafts)) sse.broadcast(evt);
    } catch (err) {
      console.error('[board-server] 记录变更事件失败:', err);
    }
  }

  /**
   * 串行化执行 —— 并发写时若两次 diff 撞同一基线，会把同一批变更重复发两遍；
   * 用 Promise 链强制顺序执行，规避此竞争。
   */
  let recordChain: Promise<void> = Promise.resolve();
  function serialize(fn: () => Promise<void>): Promise<void> {
    recordChain = recordChain.then(fn);
    return recordChain;
  }

  /** 写场景后：产事件流事件 + 广播 board-changed（Web 据此整板刷新，过渡期保留）。 */
  function recordChange(actor: string): Promise<void> {
    return serialize(async () => {
      await syncSceneEvents(actor);
      sse.broadcast({ type: 'board-changed' });
    });
  }

  /** 直接发出一条结构化事件（task 等非 board.json 来源用）。 */
  function emitEvent(
    type: BoardEventType,
    actor: string,
    payload: Record<string, unknown>,
  ): void {
    for (const evt of events.append([{ type, actor, payload }])) {
      sse.broadcast(evt);
    }
  }

  /** 执行一次 reconcile：files/ → Y.Doc。结果通过 room.mutate 写入。 */
  async function reconcileOnce(reason: string): Promise<void> {
    try {
      const result = await runReconcile({
        dir,
        scene: room.getScene(),
        previewLimitMB: currentMeta.settings.previewSizeLimitMB,
        actor: SYSTEM_ACTOR,
      });
      if (result.changed) {
        console.log(
          `[board-server] reconcile(${reason}): 新增 ${result.added.length}` +
            ` / 移动 ${result.moved.length}` +
            ` / 缺失 ${result.missing.length} 个 file 元素`,
        );
        room.mutate(SYSTEM_ACTOR, () => result.scene);
        await recordChange(SYSTEM_ACTOR);
      }
    } catch (err) {
      console.error(`[board-server] reconcile(${reason}) 失败:`, err);
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
    console.error('[board-server] 扫描 files/ 失败，按空列表处理:', err);
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
    room,
    getMeta: () => currentMeta,
    setMeta: (next) => { currentMeta = next; },
    pauseWatcher: () => watcher.pause(),
    resumeWatcher: (files) => watcher.resume(files),
  };
  const server = createHttpServer(deps);

  // M4 增量2：把 /yjs 路径下的 HTTP upgrade 升级为 Y.Doc 协同 ws。
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0];
    if (path && path.startsWith('/yjs')) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        room.handleWsConnection(ws);
      });
    } else {
      socket.destroy();
    }
  });

  server.on('error', (err) => {
    console.error(`[board-server] HTTP 服务启动失败 (端口 ${PORT}):`, err);
    sse.closeAll();
    room.close();
    void watcher.close().finally(() => process.exit(1));
  });

  server.listen(PORT, HOST, () => {
    console.log(`[board-server] M4 已启动 http://${HOST}:${PORT}`);
    console.log(`[board-server] Yjs 协同端点: ws://${HOST}:${PORT}/yjs`);
    console.log(`[board-server] 白板目录: ${dir}`);
    console.log(`[board-server] 初始文件数: ${initialFiles.length}`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[board-server] 收到 ${signal}，正在关闭...`);
    if (debounceTimer) clearTimeout(debounceTimer);
    clearInterval(presencePrune);
    sse.closeAll();
    // 关停前强制把 Y.Doc 投影到 board.json，避免节流窗口里的未写改动丢失
    void room.flushToDisk().finally(() => {
      room.close();
      wss.close();
      server.close();
      void watcher.close().finally(() => process.exit(0));
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[board-server] 启动失败:', err);
  process.exit(1);
});
