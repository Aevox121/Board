/**
 * HTTP API — Node 内置 `node:http`，host 固定 127.0.0.1（PRD §12 安全）。
 *
 * 统一响应信封：`{ ok, data, error }`（见 specs/CLI与MCP规格.md §1.3）。
 *
 * 端点：
 *  - GET  /api/health           → 服务状态（M1）
 *  - GET  /api/board            → { meta, scene, files }（M1）
 *  - PUT  /api/board            → 请求体 { scene } → saveBoard 落盘（M1）
 *  - GET  /api/files/<相对路径>  → files/ 下文件原始内容（M2，含防目录穿越）
 *  - POST /api/files/move       → 移动 files/ 内文件（M2 增量2：画布→文件系统）
 *  - GET  /api/events           → SSE，board 变化时推送 board-changed（M2）
 */
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, resolve, sep } from 'node:path';
import { guessMime, normalizePath, SCHEMA_VERSION, type BoardScene } from '@board/core';
import { loadBoard, saveBoard } from '@board/core/node';
import type { SseHub } from './sse.js';

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
  /** SSE 广播器，用于 GET /api/events 长连接 */
  sse: SseHub;
  /**
   * 立即执行一次 reconcile（文件系统 → 画布）。
   * 文件移动等服务端写操作后调用，使 board.json 即时同步并广播 board-changed，
   * 不必等 chokidar 监听的防抖窗口。
   */
  reconcileNow(reason: string): Promise<void>;
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
    milestone: 'M2',
    schemaVersion: SCHEMA_VERSION,
    dir: deps.dir,
    files: deps.getFiles().length,
    /** 当前 SSE 在线连接数 */
    sseClients: deps.sse.size(),
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

/**
 * GET /api/files/<相对路径> —— 返回 files/ 下该文件的原始内容。
 *
 * 安全（关键）：解析后的绝对路径必须仍落在 `<dir>/files/` 内，
 * 否则视为目录穿越攻击，返回 403。文件不存在返回 404。
 *
 * @param relUrlPath URL 中 `/api/files/` 之后的部分（尚未 decode）
 */
async function handleGetFile(
  deps: HttpDeps,
  res: ServerResponse,
  relUrlPath: string,
): Promise<void> {
  // URL 解码（路径可能含中文 / 空格等）
  let decoded: string;
  try {
    decoded = decodeURIComponent(relUrlPath);
  } catch {
    fail(res, 400, '文件路径编码非法');
    return;
  }

  // 规范化为 files/ 内相对路径（统一斜杠、去首尾斜杠）
  const rel = normalizePath(decoded);
  if (!rel) {
    fail(res, 400, '缺少文件路径');
    return;
  }

  // 防目录穿越：把相对路径拼到 files/ 根下并 resolve，
  // 结果必须仍以 files/ 根（含末尾分隔符）为前缀。
  const filesRoot = resolve(deps.dir, 'files');
  const target = resolve(filesRoot, rel);
  const rootPrefix = filesRoot.endsWith(sep) ? filesRoot : filesRoot + sep;
  if (target !== filesRoot && !target.startsWith(rootPrefix)) {
    fail(res, 403, '禁止访问 files/ 之外的路径');
    return;
  }

  // stat：文件不存在 → 404；指向目录 → 400
  let st;
  try {
    st = await stat(target);
  } catch {
    fail(res, 404, `文件不存在: ${rel}`);
    return;
  }
  if (!st.isFile()) {
    fail(res, 400, `路径不是文件: ${rel}`);
    return;
  }

  // 流式返回原始内容；Content-Type 按扩展名猜测
  res.writeHead(200, {
    'Content-Type': guessMime(rel),
    'Content-Length': String(st.size),
  });
  const stream = createReadStream(target);
  stream.on('error', (err) => {
    console.error('[board-server] 读取文件流出错:', err);
    if (!res.headersSent) {
      fail(res, 500, `读取文件失败: ${errMsg(err)}`);
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
}

/**
 * POST /api/files/move —— 把 files/ 下的一个文件移动到新的相对路径。
 *
 * 请求体 `{ from, to }`，两者均为相对 files/ 的路径。这是「画布 → 文件系统」
 * 方向的同步入口：Web 端拖动文件卡跨区域时调用，server 据此重命名真实文件，
 * 再 reconcile 把变更同步回画布。
 *
 * 约束：
 *  - from / to 解析后必须仍落在 files/ 内（防目录穿越）。
 *  - from 必须是已存在的文件；to 不得已存在（避免静默覆盖）。
 *  - 重命名成功后立即 reconcile 并广播，Web 端据 SSE 刷新。
 */
async function handleMoveFile(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // 解析并校验请求体
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    fail(res, 400, errMsg(err));
    return;
  }
  if (typeof body !== 'object' || body === null) {
    fail(res, 400, '请求体必须为 { from, to }');
    return;
  }
  const rawFrom = (body as Record<string, unknown>)['from'];
  const rawTo = (body as Record<string, unknown>)['to'];
  if (typeof rawFrom !== 'string' || typeof rawTo !== 'string') {
    fail(res, 400, 'from / to 必须为字符串');
    return;
  }

  const from = normalizePath(rawFrom);
  const to = normalizePath(rawTo);
  if (!from || !to) {
    fail(res, 400, 'from / to 不能为空');
    return;
  }
  if (from === to) {
    fail(res, 400, '源路径与目标路径相同');
    return;
  }

  // 防目录穿越：from / to 解析后都必须落在 files/ 内
  const filesRoot = resolve(deps.dir, 'files');
  const fromAbs = resolve(filesRoot, from);
  const toAbs = resolve(filesRoot, to);
  const rootPrefix = filesRoot.endsWith(sep) ? filesRoot : filesRoot + sep;
  if (!fromAbs.startsWith(rootPrefix) || !toAbs.startsWith(rootPrefix)) {
    fail(res, 403, '禁止访问 files/ 之外的路径');
    return;
  }

  // from 必须是已存在文件
  let fromStat;
  try {
    fromStat = await stat(fromAbs);
  } catch {
    fail(res, 404, `源文件不存在: ${from}`);
    return;
  }
  if (!fromStat.isFile()) {
    fail(res, 400, `源路径不是文件: ${from}`);
    return;
  }

  // to 不得已存在 —— stat 成功即冲突
  let toExists = true;
  try {
    await stat(toAbs);
  } catch {
    toExists = false;
  }
  if (toExists) {
    fail(res, 409, `目标已存在: ${to}`);
    return;
  }

  // 建目标父目录并重命名
  try {
    await mkdir(dirname(toAbs), { recursive: true });
    await rename(fromAbs, toAbs);
  } catch (err) {
    fail(res, 500, `移动文件失败: ${errMsg(err)}`);
    return;
  }

  // 立即 reconcile：旧路径 file 元素移除、新路径元素按区域归位，并广播 board-changed
  await deps.reconcileNow('move');
  ok(res, { from, to });
}

/** GET /api/events —— SSE 长连接，board 变化时推送 board-changed。 */
function handleEvents(deps: HttpDeps, req: IncomingMessage, res: ServerResponse): void {
  deps.sse.handle(req, res);
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
  if (path === '/api/events' && method === 'GET') {
    handleEvents(deps, req, res);
    return;
  }
  // POST /api/files/move —— 文件移动；须先于 /api/files/ 文件读取分支判断
  if (path === '/api/files/move' && method === 'POST') {
    await handleMoveFile(deps, req, res);
    return;
  }
  // GET /api/files/<相对路径> —— 注意用未折叠斜杠的原始 pathname 取子路径
  if (path.startsWith('/api/files/') || path === '/api/files') {
    if (method !== 'GET') {
      fail(res, 405, `方法 ${method} 不被 ${path} 支持`);
      return;
    }
    // 用原始 pathname（保留中间斜杠层级），去掉前缀 `/api/files/`
    const rawPath = url.pathname;
    const sub = rawPath.startsWith('/api/files/')
      ? rawPath.slice('/api/files/'.length)
      : '';
    await handleGetFile(deps, res, sub);
    return;
  }

  // 路径存在但方法不对 → 405；否则 404
  if (path === '/api/board' || path === '/api/health' || path === '/api/events') {
    fail(res, 405, `方法 ${method} 不被 ${path} 支持`);
  } else {
    fail(res, 404, `未知端点: ${method} ${path}`);
  }
}

export { HOST };
