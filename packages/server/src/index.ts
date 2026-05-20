/**
 * Board 本地服务（骨架）
 *
 * 职责（见 PRD §4 / specs/CLI与MCP规格.md §3）：
 *  - 拥有 .board 文件夹，chokidar 监听 files/ 变化
 *  - 文件系统 ⇄ 画布双向同步（specs/数据模型规格.md §5.7 / §9）
 *  - HTTP + WebSocket API（元素增删改查、上下文导出、事件流）
 *  - 内嵌 MCP Server
 *
 * 安全：仅监听 127.0.0.1（PRD §12）。
 */
import { createServer } from 'node:http';
import { SCHEMA_VERSION } from '@board/core';

const HOST = '127.0.0.1';
const PORT = Number(process.env.BOARD_PORT ?? 4500);

const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(
    JSON.stringify({
      ok: true,
      service: 'board-server',
      status: 'scaffold',
      schemaVersion: SCHEMA_VERSION,
    }),
  );
});

server.listen(PORT, HOST, () => {
  console.log(`[board-server] 骨架已启动 http://${HOST}:${PORT}`);
});

// TODO(M2): chokidar 监听 files/ + 文件系统⇄画布双向同步
// TODO(M2): HTTP/WS API — 元素 CRUD、board_read_context
// TODO(M3): 内嵌 MCP Server（与 CLI 等价的工具集）
// TODO(M4): Yjs 协同文档 + 中继服务器对接
