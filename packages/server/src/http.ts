/**
 * HTTP API — Node 内置 `node:http`，host 固定 127.0.0.1（PRD §12 安全）。
 *
 * 统一响应信封：`{ ok, data, error }`（见 specs/CLI与MCP规格.md §1.3）。
 *
 * M1 端点：
 *  - GET  /api/health  → 服务状态
 *  - GET  /api/board   → { meta, scene, files }
 *  - PUT  /api/board   → 请求体 { scene } → saveBoard 落盘
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { SCHEMA_VERSION, type BoardScene } from '@board/core';
import { loadBoard, saveBoard } from '@board/core/node';

/** 统一响应信封。 */
interface Envelope<T> {
  ok: boolean;
  data: T | null;
  error: string | null;
}

/** 创建 HTTP server 所需的依赖。 */
export interface HttpDeps {
  /** .board 目录绝对路径 */
  dir: string;
  /** 返回当前内存中的文件列表（来自 watcher） */
  getFiles(): string[];
}

const HOST = '127.0.0.1';
/** 请求体大小上限，防止异常大请求（1 MB 足够 M1 的 scene） */
const MAX_BODY_BYTES = 1024 * 1024;

/** 写出一个统一信封 JSON 响应。 */
function sendJson<T>(res: ServerResponse, status: number, body: Envelope<T>): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

/** 成功响应。 */
function ok<T>(res: ServerResponse, data: T, status = 200): void {
  sendJson(res, status, { ok: true, data, error: null });
}

/** 失败响应。 */
function fail(res: ServerResponse, status: number, error: string): void {
  sendJson(res, status, { ok: false, data: null, error });
}

/** 读取并解析请求体为 JSON；超限或解析失败抛错。 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error('请求体超过大小上限');
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) {
    throw new Error('请求体为空');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('请求体不是合法的 JSON');
  }
}

/** GET /api/health —— 服务状态。 */
function handleHealth(deps: HttpDeps, res: ServerResponse): void {
  ok(res, {
    service: 'board-server',
    status: 'ok',
    milestone: 'M1',
    schemaVersion: SCHEMA_VERSION,
    dir: deps.dir,
    files: deps.getFiles().length,
  });
}

/** GET /api/board —— 返回 meta / scene / files。 */
async function handleGetBoard(deps: HttpDeps, res: ServerResponse): Promise<void> {
  let handle;
  try {
    handle = await loadBoard(deps.dir);
  } catch (err) {
    // 白板不存在或文件损坏：给出清晰错误而非崩溃
    fail(res, 404, `读取白板失败: ${errMsg(err)}`);
    return;
  }
  ok(res, {
    meta: handle.meta,
    scene: handle.scene,
    files: deps.getFiles(),
  });
}

/** PUT /api/board —— 请求体 { scene }，落盘后返回 { ok }。 */
async function handlePutBoard(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // 解析请求体
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    fail(res, 400, errMsg(err));
    return;
  }

  // 校验 { scene } 结构
  if (typeof body !== 'object' || body === null || !('scene' in body)) {
    fail(res, 400, '请求体必须为 { scene: BoardScene }');
    return;
  }
  const scene = (body as { scene: unknown }).scene;
  if (!isBoardScene(scene)) {
    fail(res, 400, 'scene 字段结构非法（需含 schemaVersion / viewport / elements）');
    return;
  }

  // 先加载现有 meta（saveBoard 需要 meta），白板不存在则报错
  let handle;
  try {
    handle = await loadBoard(deps.dir);
  } catch (err) {
    fail(res, 404, `读取白板失败: ${errMsg(err)}`);
    return;
  }

  // 落盘
  try {
    await saveBoard(deps.dir, handle.meta, scene);
  } catch (err) {
    fail(res, 500, `保存白板失败: ${errMsg(err)}`);
    return;
  }

  ok(res, { saved: true });
}

/** 轻量结构校验：判断一个值是否像 BoardScene。 */
function isBoardScene(v: unknown): v is BoardScene {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  if (typeof s['schemaVersion'] !== 'number') return false;
  if (!Array.isArray(s['elements'])) return false;
  const vp = s['viewport'];
  if (typeof vp !== 'object' || vp === null) return false;
  const v2 = vp as Record<string, unknown>;
  return (
    typeof v2['x'] === 'number' &&
    typeof v2['y'] === 'number' &&
    typeof v2['zoom'] === 'number'
  );
}

/** 从未知错误中提取可读消息。 */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 创建 HTTP server（未 listen）。host 固定 127.0.0.1。
 */
export function createHttpServer(deps: HttpDeps): Server {
  const server = createServer((req, res) => {
    // 顶层兜底：任何未捕获异常都转成 500，绝不让进程崩溃
    void route(deps, req, res).catch((err) => {
      console.error('[board-server] 请求处理异常:', err);
      if (!res.headersSent) {
        fail(res, 500, `服务器内部错误: ${errMsg(err)}`);
      } else {
        res.end();
      }
    });
  });
  return server;
}

/** 路由分发。 */
async function route(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method ?? 'GET';
  // 只取 pathname，忽略 query；host 固定回环
  const url = new URL(req.url ?? '/', `http://${HOST}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/api/health' && method === 'GET') {
    handleHealth(deps, res);
    return;
  }
  if (path === '/api/board' && method === 'GET') {
    await handleGetBoard(deps, res);
    return;
  }
  if (path === '/api/board' && method === 'PUT') {
    await handlePutBoard(deps, req, res);
    return;
  }

  // 路径存在但方法不对 → 405；否则 404
  if (path === '/api/board' || path === '/api/health') {
    fail(res, 405, `方法 ${method} 不被 ${path} 支持`);
  } else {
    fail(res, 404, `未知端点: ${method} ${path}`);
  }
}

export { HOST };
