/**
 * Board 本地服务 — M1 装配入口
 *
 * 职责（见 PRD §4 / specs/CLI与MCP规格.md §3）：
 *  - 拥有 .board 文件夹，chokidar 监听 files/ 变化（M1：监听 + 暴露文件列表）
 *  - HTTP API（统一信封 { ok, data, error }）：
 *      GET  /api/health  · GET /api/board  · PUT /api/board
 *
 * 安全：仅监听 127.0.0.1（PRD §12）。
 *
 * 后续里程碑：
 *  - M2：文件系统 ⇄ 画布双向同步（自动排版、元素增删、缺失态）
 *  - M3：内嵌 MCP Server（与 CLI 等价的工具集）
 *  - M4：Yjs 协同文档 + 中继服务器对接
 */
import { resolve } from 'node:path';
import { listBoardFiles, loadBoard } from '@board/core/node';
import { createHttpServer, HOST, type HttpDeps } from './http';
import { startWatcher, type BoardWatcher } from './watcher';

/** 默认监听端口，可用 BOARD_PORT 覆盖。 */
const PORT = Number(process.env.BOARD_PORT ?? 4500);

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

  // 取初始文件列表，失败时降级为空列表（files/ 可能不存在）
  let initialFiles: string[] = [];
  try {
    initialFiles = await listBoardFiles(dir);
  } catch (err) {
    console.error('[board-server] 扫描 files/ 失败，按空列表处理:', err);
  }

  // 启动文件监听（M1：仅维护内存文件列表 + 打印变更）
  const watcher: BoardWatcher = startWatcher(dir, initialFiles);

  // 装配 HTTP server
  const deps: HttpDeps = {
    dir,
    getFiles: () => watcher.getFiles(),
  };
  const server = createHttpServer(deps);

  // 端口被占用等监听错误：打印后退出，避免无声失败
  server.on('error', (err) => {
    console.error(`[board-server] HTTP 服务启动失败 (端口 ${PORT}):`, err);
    void watcher.close().finally(() => process.exit(1));
  });

  server.listen(PORT, HOST, () => {
    console.log(`[board-server] M1 已启动 http://${HOST}:${PORT}`);
    console.log(`[board-server] 白板目录: ${dir}`);
    console.log(`[board-server] 初始文件数: ${initialFiles.length}`);
  });

  // 优雅退出：关闭监听与 HTTP server
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[board-server] 收到 ${signal}，正在关闭...`);
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
