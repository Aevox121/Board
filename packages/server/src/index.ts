/**
 * Board 本地服务 — M2 装配入口
 *
 * 职责（见 PRD §4 / specs/数据模型规格.md §5.7 / §9）：
 *  - 拥有 .board 文件夹，chokidar 监听 files/ 变化
 *  - 文件 add/change/unlink 时执行 reconcile：files/ → 画布 file 元素
 *  - HTTP API（统一信封 { ok, data, error }）：
 *      GET  /api/health  · GET /api/board  · PUT /api/board
 *      GET  /api/files/<相对路径>  · GET /api/events (SSE)
 *
 * 安全：仅监听 127.0.0.1（PRD §12）。
 *
 * 后续里程碑：
 *  - M3：内嵌 MCP Server（与 CLI 等价的工具集）
 *  - M4：Yjs 协同文档 + 中继服务器对接
 */
import { resolve } from 'node:path';
import {
  diffScenes,
  type BoardEventType,
  type BoardOp,
  type BoardScene,
} from '@board/core';
import { listBoardFiles, loadBoard } from '@board/core/node';
import { createEventLog } from './events.js';
import { createHttpServer, HOST, type HttpDeps } from './http.js';
import { createPresenceHub } from './presence.js';
import { runReconcile } from './reconcile.js';
import { createSseHub } from './sse.js';
import { createTaskStore } from './tasks.js';
import { startWatcher, type BoardWatcher } from './watcher.js';

/** 默认监听端口，可用 BOARD_PORT 覆盖。 */
const PORT = Number(process.env.BOARD_PORT ?? 4500);

/** 文件系统变更触发 reconcile 的固定操作者身份（系统）。 */
const SYSTEM_ACTOR = 'u_system';

/** reconcile 防抖窗口（毫秒）——批量文件变更只触发一次 reconcile。 */
const RECONCILE_DEBOUNCE_MS = 200;

/** 打印用法并以非零码退出。 */
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

/**
 * 解析 .board 目录：命令行参数 process.argv[2] 优先，其次环境变量 BOARD_DIR。
 * 都没有则打印用法并退出。
 */
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
  try {
    await loadBoard(dir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[board-server] 无法打开白板 ${dir}`);
    console.error(`[board-server] 原因: ${msg}`);
    console.error('[board-server] 请确认该路径是一个有效的 .board 文件夹。');
    process.exit(1);
  }

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

  // 服务启动时先做一次初始 reconcile，让 files/ 里已有文件生成 file 元素。
  // 启动 reconcile 不产事件 —— 已有文件不是「新增」。
  try {
    await runReconcile(dir, SYSTEM_ACTOR);
  } catch (err) {
    console.error('[board-server] 启动 reconcile 失败:', err);
  }

  // 事件 diff 的基线场景 —— 取启动 reconcile 之后的场景。后续每次变更都与它比对。
  let lastScene: BoardScene = (await loadBoard(dir)).scene;

  /**
   * 比对 board.json 与基线场景，产出 element / file / region 类事件流事件并
   * 广播，更新基线。不广播 board-changed / ops —— 由调用方按写入方式补。
   */
  async function syncSceneEvents(actor: string): Promise<void> {
    try {
      const handle = await loadBoard(dir);
      const drafts = diffScenes(lastScene, handle.scene, actor);
      lastScene = handle.scene;
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

  /**
   * 整场景写入（PUT / reconcile / 端点等）后：产事件流事件 + 广播 board-changed
   * （Web 据此整板刷新）。
   */
  function recordChange(actor: string): Promise<void> {
    return serialize(async () => {
      await syncSceneEvents(actor);
      sse.broadcast({ type: 'board-changed' });
    });
  }

  /**
   * 操作级写入（POST /api/ops）后：产事件流事件 + 广播 ops 帧。各端据 ops 帧
   * 增量更新；`origin` 让发起方忽略自己的回声。不广播 board-changed —— 避免
   * 各端再做一次整板刷新、把彼此未同步的本地编辑冲掉。
   */
  function recordOps(actor: string, ops: BoardOp[], origin: string): Promise<void> {
    return serialize(async () => {
      await syncSceneEvents(actor);
      const frame = { type: 'ops', ops, origin };
      sse.broadcast(frame);
    });
  }

  /**
   * 直接发出一条结构化事件（task 等非 board.json 来源用）。
   * 不广播 board-changed —— 调用方按需自行广播。
   */
  function emitEvent(
    type: BoardEventType,
    actor: string,
    payload: Record<string, unknown>,
  ): void {
    for (const evt of events.append([{ type, actor, payload }])) {
      sse.broadcast(evt);
    }
  }

  /**
   * 执行一次 reconcile：files/ → 画布。
   * changed 时经 recordChange 产出 file.* 事件并广播。失败仅打印，不让进程崩溃。
   */
  async function reconcileOnce(reason: string): Promise<void> {
    try {
      const result = await runReconcile(dir, SYSTEM_ACTOR);
      if (result.changed) {
        console.log(
          `[board-server] reconcile(${reason}): 新增 ${result.added.length}` +
            ` / 移动 ${result.moved.length}` +
            ` / 缺失 ${result.missing.length} 个 file 元素`,
        );
        await recordChange(SYSTEM_ACTOR);
      }
    } catch (err) {
      console.error(`[board-server] reconcile(${reason}) 失败:`, err);
    }
  }

  // reconcile 防抖：批量文件变更（如解压、批量拷贝）合并为一次 reconcile
  let debounceTimer: NodeJS.Timeout | null = null;
  function scheduleReconcile(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void reconcileOnce('watch');
    }, RECONCILE_DEBOUNCE_MS);
  }

  // 取初始文件列表，失败时降级为空列表（files/ 可能不存在）
  let initialFiles: string[] = [];
  try {
    initialFiles = await listBoardFiles(dir);
  } catch (err) {
    console.error('[board-server] 扫描 files/ 失败，按空列表处理:', err);
  }

  // 启动文件监听：文件 add/change/unlink → 防抖后触发 reconcile
  const watcher: BoardWatcher = startWatcher(dir, initialFiles, () => {
    scheduleReconcile();
  });

  // 装配 HTTP server。reconcileNow 复用上面的 reconcileOnce ——
  // POST /api/files/move 等写操作后即时同步画布，不必等 watcher 防抖窗口。
  const deps: HttpDeps = {
    dir,
    getFiles: () => watcher.getFiles(),
    sse,
    tasks,
    reconcileNow: reconcileOnce,
    events,
    presence,
    recordChange,
    recordOps,
    emitEvent,
  };
  const server = createHttpServer(deps);

  // 端口被占用等监听错误：打印后退出，避免无声失败
  server.on('error', (err) => {
    console.error(`[board-server] HTTP 服务启动失败 (端口 ${PORT}):`, err);
    sse.closeAll();
    void watcher.close().finally(() => process.exit(1));
  });

  server.listen(PORT, HOST, () => {
    console.log(`[board-server] M2 已启动 http://${HOST}:${PORT}`);
    console.log(`[board-server] 白板目录: ${dir}`);
    console.log(`[board-server] 初始文件数: ${initialFiles.length}`);
  });

  // 优雅退出：关闭监听、SSE 连接与 HTTP server
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[board-server] 收到 ${signal}，正在关闭...`);
    if (debounceTimer) clearTimeout(debounceTimer);
    clearInterval(presencePrune);
    sse.closeAll();
    server.close();
    void watcher.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// 顶层兜底：任何未预期错误都打印后退出，不留下崩溃栈
main().catch((err) => {
  console.error('[board-server] 启动失败:', err);
  process.exit(1);
});
