/**
 * board-server HTTP 客户端 —— web ⇄ server 对接（M1）。
 *
 * server 在 `127.0.0.1:4500` 暴露 HTTP API，统一信封 `{ ok, data, error }`。
 * dev 环境下 `/api` 经 Vite proxy 转发到 server，避开 CORS（见 vite.config.ts）。
 *
 * 本模块只用浏览器内置 `fetch`，不引入额外依赖。所有网络/解析错误统一收敛为
 * `ServerError`，调用方据此优雅降级到离线模式（不崩）。
 *
 * 端点：
 *  - `checkHealth()` —— GET /api/health，探测服务是否可达。
 *  - `fetchBoard()`  —— GET /api/board，取 meta + scene + files。
 *  - `putScene()`    —— PUT /api/board，把当前场景落盘。
 */
import {
  type BoardScene,
  type BoardMeta,
  parseScene,
  parseMeta,
  serializeScene,
  serializeMeta,
} from '@board/core';

/** API 基址 —— 走相对路径，dev 由 Vite proxy 转发，生产同源部署亦可用。 */
const API_BASE = '/api';

/** 请求超时（毫秒）—— server 不可达时尽快降级，不让启动流程长时间挂起。 */
const REQUEST_TIMEOUT_MS = 4000;

/** 统一响应信封 —— 与 server 端 `Envelope<T>` 对应。 */
interface Envelope<T> {
  ok: boolean;
  data: T | null;
  error: string | null;
}

/**
 * server 交互失败时统一抛出。
 * 涵盖网络不可达、超时、HTTP 错误码、信封 `ok:false`、响应体解析失败。
 */
export class ServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerError';
  }
}

/** GET /api/health 的 data 形状（server handleHealth）。 */
export interface HealthInfo {
  service: string;
  status: string;
  milestone: string;
  schemaVersion: number;
  dir: string;
  files: number;
}

/** GET /api/board 解析后的结果 —— meta/scene 为强类型，files 为相对路径列表。 */
export interface BoardData {
  meta: BoardMeta;
  scene: BoardScene;
  files: string[];
}

/**
 * 带超时的 fetch —— 用 AbortController 在 REQUEST_TIMEOUT_MS 后中断。
 * 任何网络层失败（含中断）统一转成 ServerError。
 */
async function fetchWithTimeout(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: controller.signal,
    });
  } catch (err) {
    // fetch 抛错通常意味着 server 未启动 / 网络中断 / 超时中断。
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ServerError(`请求 ${path} 超时（${REQUEST_TIMEOUT_MS}ms）`);
    }
    throw new ServerError(`无法连接 board-server：${describeError(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** 把响应体解析为统一信封，并校验 `ok` 与 HTTP 状态。 */
async function readEnvelope<T>(res: Response, path: string): Promise<T> {
  let body: Envelope<T>;
  try {
    body = (await res.json()) as Envelope<T>;
  } catch {
    throw new ServerError(`${path} 响应不是合法 JSON（HTTP ${res.status}）`);
  }
  if (!res.ok || !body.ok) {
    const reason = body.error ?? `HTTP ${res.status}`;
    throw new ServerError(`${path} 失败：${reason}`);
  }
  if (body.data === null || body.data === undefined) {
    throw new ServerError(`${path} 响应缺少 data 字段`);
  }
  return body.data;
}

/** 从未知错误提取可读消息。 */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * 探测 board-server 是否可达。
 * @returns 服务可达时的 HealthInfo。
 * @throws  ServerError —— 服务不可达或返回异常。
 */
export async function checkHealth(): Promise<HealthInfo> {
  const res = await fetchWithTimeout('/health', { method: 'GET' });
  return readEnvelope<HealthInfo>(res, 'GET /api/health');
}

/**
 * 拉取 server 持有的白板（meta + scene + files）。
 *
 * server 返回的 meta/scene 为原始 JSON 对象，这里用 @board/core 的
 * `parseMeta` / `parseScene` 做结构校验，确保进入 BoardProvider 的是合法数据。
 *
 * @throws ServerError —— 服务不可达、HTTP 错误、或返回的数据结构非法。
 */
export async function fetchBoard(): Promise<BoardData> {
  const res = await fetchWithTimeout('/board', { method: 'GET' });
  const data = await readEnvelope<{
    meta: unknown;
    scene: unknown;
    files: unknown;
  }>(res, 'GET /api/board');

  // server 已是结构化对象；复用 core 的解析器做严格校验（schemaVersion 等）。
  let meta: BoardMeta;
  let scene: BoardScene;
  try {
    meta = parseMeta(serializeMeta(data.meta as BoardMeta));
    scene = parseScene(serializeScene(data.scene as BoardScene));
  } catch (err) {
    throw new ServerError(`白板数据校验失败：${describeError(err)}`);
  }

  const files = Array.isArray(data.files)
    ? data.files.filter((f): f is string => typeof f === 'string')
    : [];

  return { meta, scene, files };
}

/**
 * 把当前场景落盘到 server（PUT /api/board）。
 * @param scene 待保存的场景。
 * @throws ServerError —— 服务不可达、HTTP 错误、或 server 拒绝保存。
 */
export async function putScene(scene: BoardScene): Promise<void> {
  const res = await fetchWithTimeout('/board', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scene }),
  });
  await readEnvelope<{ saved: boolean }>(res, 'PUT /api/board');
}
