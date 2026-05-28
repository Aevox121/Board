/**
 * Board 本地服务 — M4 装配入口
 *
 * 职责（见 PRD §4 / specs/数据模型规格.md §5.7 / §9）：
 *  - 拥有一个或多个 `.board` 文件夹（多 board 中继模式，PRD §4.2）
 *  - 每个 board 由 createBoardRuntime 装配自己的 Y.Doc / 文件监听 /
 *    SSE / 事件流 / 任务 / 在场，互不串扰
 *  - HTTP 路由按 `/api/boards/<id>/...` 前缀剥离 + 默认 board 回退
 *  - ws 路由 `/yjs/<id>` 与 `/yjs`（默认）
 *  - 节流投影 Y.Doc → board.json（人可读副本 + 崩溃恢复源）
 *
 * 安全：仅监听 127.0.0.1（PRD §12 安全）。若需对外提供服务（中继），
 * 通过反向代理 / 显式 `BOARD_HOST` 环境变量改 bind 地址。
 */
import { basename, dirname, resolve } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer } from 'ws';
import {
  createHttpServer,
  HOST as DEFAULT_HOST,
  type AuthChecker,
  type HttpDeps,
} from './http.js';
import { createBoardRuntime, type BoardRuntime } from './runtime.js';
import { createBoardsManager } from './boards-manager.js';

/** 默认监听端口，可用 BOARD_PORT 覆盖。 */
const PORT = Number(process.env.BOARD_PORT ?? 4500);
/** 默认 bind 地址（PRD §12：127.0.0.1）。中继模式可设为 0.0.0.0。 */
const HOST = process.env.BOARD_HOST?.trim() || DEFAULT_HOST;
/**
 * `BOARD_REQUIRE_TOKEN=true` 时强制 token 鉴权（公网中继部署）。
 * 默认不强制 —— 本地 dev / 单 board 不必为鉴权操心。
 */
const REQUIRE_TOKEN = (process.env.BOARD_REQUIRE_TOKEN ?? '').toLowerCase() === 'true';

/** 从请求里取 token：先看 ?token=，再看 Authorization: Bearer。 */
function extractToken(url: URL, req: IncomingMessage): string | null {
  const q = url.searchParams.get('token');
  if (q && q.trim()) return q.trim();
  const auth = req.headers['authorization'];
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1]!.trim();
  }
  return null;
}

function printUsageAndExit(): never {
  console.error(
    [
      'Board 本地服务 — 用法:',
      '',
      '  board-server <.board 目录> [<.board 目录> ...]',
      '  BOARD_DIR=<.board 目录>[,<.board 目录>...] board-server',
      '',
      '可选环境变量:',
      '  BOARD_PORT   HTTP 端口（默认 4500）',
      '  BOARD_HOST   bind 地址（默认 127.0.0.1；中继公网可设 0.0.0.0）',
      '',
      '示例:',
      '  board-server ./boards/旅行计划.board',
      '  board-server ./旅行.board ./菜谱.board   # 多 board 中继',
    ].join('\n'),
  );
  process.exit(1);
}

/** 从 dir basename 派生 boardId（去掉 `.board` 后缀，URL-safe）。 */
function deriveBoardId(dir: string): string {
  const base = basename(dir).replace(/\.board$/i, '');
  return base || 'board';
}

/** 解析启动参数：位置参数 + BOARD_DIR(逗号分隔) → 一组 .board 绝对路径。 */
function resolveBoardDirs(): string[] {
  const fromArgs = process.argv.slice(2).filter((s) => s && !s.startsWith('-'));
  const fromEnv = (process.env.BOARD_DIR ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const raw = fromArgs.length > 0 ? fromArgs : fromEnv;
  if (raw.length === 0) printUsageAndExit();
  return raw.map((p) => resolve(p));
}

async function main(): Promise<void> {
  const dirs = resolveBoardDirs();

  // 装配每个 board 的 runtime。任一失败则整体退出 —— 多 board 启动时
  // 路径错误应即时暴露，而非静默跳过造成行为偏离预期。
  const initial: BoardRuntime[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const boardId = deriveBoardId(dir);
    if (seen.has(boardId)) {
      console.error(
        `[board-server] 多个目录派生出相同 boardId="${boardId}" —— ` +
          `请重命名 ${dir} 或检查重复传参`,
      );
      for (const rt of initial) await rt.close();
      process.exit(1);
    }
    seen.add(boardId);
    try {
      const rt = await createBoardRuntime({ boardId, dir });
      initial.push(rt);
    } catch (err) {
      console.error('[board-server] 启动失败：', err);
      for (const rt of initial) await rt.close();
      process.exit(1);
    }
  }

  // 新建 board 的父目录 —— BOARDS_ROOT 优先，否则取第一个 board 所在父目录。
  // 让 web 端「+ 新建」时新 board 与既有 board 共处一处，符合直觉。
  const boardsRoot = resolve(
    process.env.BOARDS_ROOT?.trim() || dirname(initial[0]!.dir),
  );

  const boardsManager = createBoardsManager({ initial, boardsRoot });

  /** HTTP 路由的 deps 解析 —— null = 默认 board。 */
  const getDeps = (boardId: string | null): HttpDeps | null => {
    const id = boardId ?? boardsManager.getDefaultId();
    return boardsManager.get(id)?.deps ?? null;
  };

  /** token 鉴权 —— 仅在 BOARD_REQUIRE_TOKEN=true 时注入到 server。 */
  const checkAuth: AuthChecker | undefined = REQUIRE_TOKEN
    ? (deps, url, req) => {
        const expected = deps.getMeta().shareToken;
        if (!expected) return true; // 该 board 无 token（极端兜底）—— 放行
        const token = extractToken(url, req);
        return token !== null && token === expected;
      }
    : undefined;

  const server = createHttpServer(getDeps, checkAuth, boardsManager);

  // ws 升级 —— 路径 `/yjs/<id>` 或 `/yjs`（默认 board）。
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${HOST}`);
    } catch {
      socket.destroy();
      return;
    }
    const rawPath = url.pathname;
    let boardId: string | null = null;
    if (rawPath === '/yjs') {
      boardId = null;
    } else {
      const m = /^\/yjs\/([^/]+)$/.exec(rawPath);
      if (m) {
        try {
          boardId = decodeURIComponent(m[1]!);
        } catch {
          // 非法编码 —— 直接关掉，别让进程崩
          socket.destroy();
          return;
        }
      } else {
        socket.destroy();
        return;
      }
    }
    const rt = boardsManager.get(boardId ?? boardsManager.getDefaultId());
    if (!rt) {
      socket.destroy();
      return;
    }
    // ws 鉴权 —— 与 HTTP 同策略：仅 BOARD_REQUIRE_TOKEN=true 时强制
    if (checkAuth && !checkAuth(rt.deps, url, req)) {
      // ws 无标准 401 帧；按 RFC 6455 在 upgrade 阶段写 HTTP 401 再断
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    // 关 Nagle（TCP_NODELAY）—— Y.Doc 增量帧小，避免被攒包，实时同步更跟手。
    // 这是 server↔(vite proxy) 的回环腿；client↔vite 的 WiFi 腿在 vite 侧关。
    if (typeof (socket as { setNoDelay?: unknown }).setNoDelay === 'function') {
      (socket as unknown as { setNoDelay: (b: boolean) => void }).setNoDelay(
        true,
      );
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      rt.room.handleWsConnection(ws);
    });
  });

  server.on('error', (err) => {
    console.error(`[board-server] HTTP 服务启动失败 (端口 ${PORT}):`, err);
    void Promise.all(
      boardsManager.list().map((b) => boardsManager.get(b.id)!.close()),
    ).finally(() => process.exit(1));
  });

  server.listen(PORT, HOST, () => {
    console.log(`[board-server] M4 已启动 http://${HOST}:${PORT}`);
    console.log(
      `[board-server] token 鉴权: ${REQUIRE_TOKEN ? '已启用 (BOARD_REQUIRE_TOKEN=true)' : '未启用'}`,
    );
    const list = boardsManager.list();
    console.log(
      `[board-server] 加载 ${list.length} 个白板（默认: ${boardsManager.getDefaultId()}），新建落点: ${boardsRoot}`,
    );
    for (const b of list) {
      const rt = boardsManager.get(b.id)!;
      const tok = rt.deps.getMeta().shareToken;
      console.log(`  · ${b.id}  →  ${rt.dir}`);
      console.log(`     HTTP: http://${HOST}:${PORT}/api/boards/${encodeURIComponent(b.id)}/board`);
      console.log(`     ws:   ws://${HOST}:${PORT}/yjs/${encodeURIComponent(b.id)}`);
      if (REQUIRE_TOKEN && tok) {
        console.log(`     token: ${tok}`);
      }
    }
    if (list.length === 1) {
      console.log(`[board-server] 单 board 兼容路径仍可用: /api/board · ws:/yjs`);
    }
    if (!REQUIRE_TOKEN) {
      console.log(`[board-server] boards 管理端点已启用: GET/POST /api/boards · DELETE /api/boards/<id>`);
    }
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[board-server] 收到 ${signal}，正在关闭...`);
    void Promise.all(
      boardsManager.list().map((b) => boardsManager.get(b.id)!.close()),
    ).finally(() => {
      wss.close();
      server.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[board-server] 启动失败:', err);
  process.exit(1);
});
