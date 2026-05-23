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
 *  - `putScene()`    —— PUT /api/board，整场景落盘（导入等全量替换用）。
 *
 * 实时场景同步（M4 增量3 起）走 ws /yjs（见 board/yjs-client.ts），不再
 * 经 HTTP /api/ops。
 */
import {
  type BoardScene,
  type BoardMeta,
  type BoardTask,
  type SnapshotIndexEntry,
  parseScene,
  parseMeta,
  serializeScene,
  serializeMeta,
} from '@board/core';
import { apiUrl } from './boardSession';

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
  /** Agent 任务（Pencil 式过程可视化，M3） */
  tasks: BoardTask[];
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
    return await fetch(apiUrl(path), {
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
    tasks: unknown;
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

  // 任务为运行时态，无严格 schema —— 轻量过滤为带 id 的对象即可。
  const tasks: BoardTask[] = Array.isArray(data.tasks)
    ? (data.tasks.filter(
        (t): t is BoardTask =>
          typeof t === 'object' &&
          t !== null &&
          typeof (t as BoardTask).id === 'string',
      ) as BoardTask[])
    : [];

  return { meta, scene, files, tasks };
}

// ───────────────────── 快照 / 复原（PRD §8.5）─────────────────────

/** 列出当前所有存档点。 */
export async function listSnapshots(): Promise<SnapshotIndexEntry[]> {
  const res = await fetchWithTimeout('/snapshots');
  const data = await readEnvelope<{ snapshots: SnapshotIndexEntry[] }>(
    res,
    'GET /api/snapshots',
  );
  return data.snapshots;
}

/** 建一份手动存档点（PRD §8.5）。 */
export async function createSnapshot(
  name: string | null,
  actor = 'u_local',
): Promise<SnapshotIndexEntry> {
  const res = await fetchWithTimeout('/snapshots', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, actor }),
  });
  const data = await readEnvelope<{ snapshot: SnapshotIndexEntry }>(
    res,
    'POST /api/snapshots',
  );
  return data.snapshot;
}

/** 删除一份存档点。 */
export async function deleteSnapshotApi(snapshotId: string): Promise<void> {
  const res = await fetchWithTimeout(
    `/snapshots/${encodeURIComponent(snapshotId)}`,
    { method: 'DELETE' },
  );
  await readEnvelope<{ removed: string }>(
    res,
    `DELETE /api/snapshots/${snapshotId}`,
  );
}

/** 一键复原 —— server 自动建 pre-restore 档后复原。返回 pre-restore id。 */
export async function restoreSnapshot(
  snapshotId: string,
  actor = 'u_local',
): Promise<{ preRestoreSnapshotId: string }> {
  const res = await fetchWithTimeout(
    `/snapshots/${encodeURIComponent(snapshotId)}/restore`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor }),
    },
  );
  return await readEnvelope<{
    preRestoreSnapshotId: string;
  }>(res, `POST /api/snapshots/${snapshotId}/restore`);
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

/** 在场光标上报载荷（M4：拟人化光标）。 */
export interface PresencePayload {
  clientId: string;
  name: string;
  color: string;
  /** 画布坐标的光标位置；null = 在场但光标未知 */
  cursor: { x: number; y: number } | null;
}

/**
 * 上报本端在场光标（POST /api/presence）—— M4 拟人化光标。
 *
 * 高频、可丢：失败静默吞掉，不抛 ServerError、不走带超时的 fetch ——
 * presence 是瞬时态，丢一两帧无所谓，不该打断 UI。
 */
export async function sendPresence(p: PresencePayload): Promise<void> {
  try {
    await fetch(apiUrl('/presence'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(p),
    });
  } catch {
    // presence 可丢，忽略网络错误。
  }
}

/**
 * 移除一个任务（DELETE /api/tasks/<id>）—— 完成态任务卡的「× 关闭」与
 * 「超时自动淡出」清理。server 移除后经 SSE 广播，各端据此刷新。
 *
 * @throws ServerError —— 服务不可达 / HTTP 错误（调用方可据需要忽略）。
 */
export async function dismissTask(taskId: string): Promise<void> {
  const res = await fetchWithTimeout(`/tasks/${encodeURIComponent(taskId)}`, {
    method: 'DELETE',
  });
  await readEnvelope<{ removed: string }>(res, `DELETE /api/tasks/${taskId}`);
}

/** POST /api/elements/delete 的 data 形状（server handleDeleteElement）。 */
export interface DeleteElementResult {
  removed: string;
  type: string;
  /** file 元素被移入回收站的原相对路径；非 file 为 null。 */
  trashedFile: string | null;
  /** 连带清理掉的引用元素 id（指向被删元素的连线 / 建议）。 */
  removedRefs: string[];
}

/**
 * 删除一个元素（POST /api/elements/delete）—— `file` 元素的真实文件移入回收站，
 * 引用它的连线 / 建议连带清理。server 落盘后经 SSE 广播 board-changed。
 *
 * 画布删除 `file` 元素必须经此端点：file 背后是真实文件，仅改内存场景会被
 * 下次 reconcile 复活。连线 / 文本卡等无文件系统对应物的元素可直接改内存场景。
 *
 * @throws ServerError —— 服务不可达 / HTTP 错误。
 */
export async function deleteElement(
  elementId: string,
): Promise<DeleteElementResult> {
  const res = await fetchWithTimeout('/elements/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ elementId }),
  });
  return readEnvelope<DeleteElementResult>(res, 'POST /api/elements/delete');
}

/**
 * 处理一条建议（建议机制，PRD §7.3）—— POST /api/suggestions/<op>。
 * server 落盘后经 SSE 广播 board-changed，各端据此刷新。
 *
 * @throws ServerError —— 服务不可达 / HTTP 错误。
 */
async function postSuggestionOp(
  op: 'accept' | 'reject' | 'describe',
  body: Record<string, unknown>,
): Promise<void> {
  const res = await fetchWithTimeout(`/suggestions/${op}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  await readEnvelope<{ suggestionId: string }>(
    res,
    `POST /api/suggestions/${op}`,
  );
}

/** 同意建议 —— 用建议内容替换 / 新增到白板，移除建议元素。 */
export async function acceptSuggestion(suggestionId: string): Promise<void> {
  await postSuggestionOp('accept', { suggestionId });
}

/** 拒绝建议 —— 删除建议元素，原件不变。 */
export async function rejectSuggestion(suggestionId: string): Promise<void> {
  await postSuggestionOp('reject', { suggestionId });
}

/** 描述建议 —— 向建议追加一条反馈，建议元素保留。 */
export async function describeSuggestion(
  suggestionId: string,
  text: string,
): Promise<void> {
  await postSuggestionOp('describe', { suggestionId, text });
}

/**
 * 上传任意文件到 .board/files/（POST /api/files/upload?path=…）。
 *
 * @param targetPath 文件在 files/ 下的目标相对路径（含文件名，用 `/` 分隔）。
 * @param blob       文件二进制内容（File / Blob）。
 * @returns 服务端返回的实际路径 + 字节数。
 * @throws ServerError —— 服务不可达 / 路径非法 / 已存在 / 写盘失败。
 */
export async function uploadFile(
  targetPath: string,
  blob: Blob,
): Promise<{ path: string; size: number }> {
  const qs = `?path=${encodeURIComponent(targetPath)}`;
  const res = await fetchWithTimeout(`/files/upload${qs}`, {
    method: 'POST',
    headers: {
      'Content-Type': blob.type || 'application/octet-stream',
    },
    body: blob,
  });
  return readEnvelope<{ path: string; size: number }>(
    res,
    'POST /api/files/upload',
  );
}
