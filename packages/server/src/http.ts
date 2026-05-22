/**
 * HTTP API — Node 内置 `node:http`，host 固定 127.0.0.1（PRD §12 安全）。
 *
 * 统一响应信封：`{ ok, data, error }`（见 specs/CLI与MCP规格.md §1.3）。
 *
 * 端点：
 *  - GET  /api/health           → 服务状态（M1）
 *  - GET  /api/board            → { meta, scene, files }（M1）
 *  - PUT  /api/board            → 请求体 { scene } → saveBoard 落盘（M1）
 *  - POST /api/ops              → 元素级操作合并入 board.json（M4：实时同步）
 *  - POST /api/presence         → 在场光标上报 / 离开（M4：拟人化光标）
 *  - GET  /api/files/<相对路径>  → files/ 下文件原始内容（M2，含防目录穿越）
 *  - POST /api/files/move       → 移动 files/ 内文件（M2 增量2：画布→文件系统）
 *  - POST /api/tasks            → 新建 Agent 任务（M3：Pencil 式过程可视化）
 *  - POST /api/tasks/progress   → 上报任务进度
 *  - POST /api/tasks/finish     → 完成任务，draft 元素转 committed
 *  - DELETE /api/tasks/<id>     → 移除任务（× 关闭 / 完成态超时清理）
 *  - POST /api/refresh          → 外部写入后触发同步（事件流 + board-changed，M3）
 *  - POST /api/suggestions/accept  → 同意建议（M3：建议机制，PRD §7.3）
 *  - POST /api/suggestions/reject  → 拒绝建议
 *  - POST /api/suggestions/describe → 向建议追加反馈
 *  - POST /api/elements/delete  → 删除元素（file 移入回收站、连带清引用）
 *  - GET  /api/events           → SSE，board-changed + 结构化事件流（M2/M4）
 *  - GET  /api/events/log       → 按游标增量拉取留存事件（M4：事件流）
 */
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { basename, dirname, join, resolve, sep } from 'node:path';
import {
  acceptSuggestion,
  applyOps,
  clampPercent,
  commitDraftElements,
  createTask,
  describeSuggestion,
  growRegions,
  guessMime,
  isBoardOp,
  normalizePath,
  regionForFile,
  regionsOf,
  rejectSuggestion,
  removeElement,
  SCHEMA_VERSION,
  type BoardEventType,
  type BoardOp,
  type BoardScene,
  type BoardTask,
  type SuggestionResult,
} from '@board/core';
import { loadBoard, saveBoard } from '@board/core/node';
import type { EventLog } from './events.js';
import type { PresenceHub } from './presence.js';
import type { SseHub } from './sse.js';
import type { TaskStore } from './tasks.js';

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
  /** Agent 任务运行时存储（Pencil 式过程可视化，PRD §7.4） */
  tasks: TaskStore;
  /** 在场参与者注册表（M4：拟人化光标，PRD §8.2） */
  presence: PresenceHub;
  /**
   * 立即执行一次 reconcile（文件系统 → 画布）。
   * 文件移动等服务端写操作后调用，使 board.json 即时同步并广播 board-changed，
   * 不必等 chokidar 监听的防抖窗口。
   */
  reconcileNow(reason: string): Promise<void>;
  /** 事件日志 —— GET /api/events/log 按游标增量拉取。 */
  events: EventLog;
  /**
   * 比对 board.json 与基线场景，产出 element / file / region 类事件并广播；
   * 末尾广播 board-changed。改动 board.json 的整场景写操作完成后调用。
   */
  recordChange(actor: string): Promise<void>;
  /**
   * 操作级写入（POST /api/ops）完成后调用：产事件流事件 + 广播 ops 帧
   * （各端据此增量更新；`origin` 让发起方忽略回声）。不广播 board-changed。
   */
  recordOps(actor: string, ops: BoardOp[], origin: string): Promise<void>;
  /** 直接发出一条结构化事件（task 等非 board.json 来源用）。 */
  emitEvent(
    type: BoardEventType,
    actor: string,
    payload: Record<string, unknown>,
  ): void;
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
    milestone: 'M3',
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
    tasks: deps.tasks.list(),
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

  // 比对前后场景产出事件（board watch / 多端订阅据此感知 Web 编辑）。
  await deps.recordChange('u_local');
  ok(res, { saved: true });
}

/**
 * POST /api/ops —— 应用一批元素级操作（M4：操作级实时同步）。
 *
 * 请求体 `{ ops, actor?, origin? }`。各客户端只发「自己改了哪些元素」的增量
 * 操作（upsert / delete），服务端按 id 合并进 board.json —— 取代整场景 PUT，
 * 消除并发写时的「后写覆盖前写」。应用后广播 `{type:'ops',...}`，其余客户端
 * 据此增量更新；`origin`（客户端 id）让发起方忽略自己的回声。
 */
async function handleApplyOps(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    fail(res, 400, errMsg(err));
    return;
  }
  if (typeof body !== 'object' || body === null) {
    fail(res, 400, '请求体必须为 { ops: BoardOp[] }');
    return;
  }
  const rec = body as Record<string, unknown>;
  const rawOps = rec['ops'];
  if (!Array.isArray(rawOps) || !rawOps.every(isBoardOp)) {
    fail(res, 400, 'ops 必须为合法的 BoardOp 数组（upsert / delete）');
    return;
  }
  const ops = rawOps as BoardOp[];
  const actor =
    typeof rec['actor'] === 'string' && rec['actor'] ? rec['actor'] : 'u_local';
  const origin = typeof rec['origin'] === 'string' ? rec['origin'] : '';

  if (ops.length === 0) {
    ok(res, { applied: 0 });
    return;
  }

  let handle;
  try {
    handle = await loadBoard(deps.dir);
  } catch (err) {
    fail(res, 404, `读取白板失败: ${errMsg(err)}`);
    return;
  }
  const next = applyOps(handle.scene, ops);
  try {
    await saveBoard(deps.dir, handle.meta, next);
  } catch (err) {
    fail(res, 500, `保存白板失败: ${errMsg(err)}`);
    return;
  }

  await deps.recordOps(actor, ops, origin);
  ok(res, { applied: ops.length });
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

/** 画布素材（assets/）单文件大小上限 —— 25MB。 */
const MAX_ASSET_BYTES = 25 * 1024 * 1024;

/** content-type → 素材文件扩展名。 */
function extForImageMime(mime: string): string {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/bmp': 'bmp',
    'image/avif': 'avif',
  };
  return map[mime] ?? 'bin';
}

/** assetId 合法性 —— 仅 [A-Za-z0-9._-]、不含 `..`，防目录穿越。 */
function isSafeAssetId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && !id.includes('..');
}

/** 读取请求体为原始二进制（assets 上传用，限额比 JSON 体大）。 */
async function readBinaryBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_ASSET_BYTES) {
      throw new Error('上传体超过大小上限（25MB）');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * GET /api/assets/<assetId> —— 返回 assets/ 下画布素材的原始内容。
 * 安全：assetId 须合法且解析后仍落在 `<dir>/assets/` 内。
 */
async function handleGetAsset(
  deps: HttpDeps,
  res: ServerResponse,
  rawId: string,
): Promise<void> {
  let id: string;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    fail(res, 400, 'assetId 编码非法');
    return;
  }
  if (!id || !isSafeAssetId(id)) {
    fail(res, 400, `assetId 非法: ${id}`);
    return;
  }
  const assetsRoot = resolve(deps.dir, 'assets');
  const target = resolve(assetsRoot, id);
  const rootPrefix = assetsRoot.endsWith(sep) ? assetsRoot : assetsRoot + sep;
  if (!target.startsWith(rootPrefix)) {
    fail(res, 403, '禁止访问 assets/ 之外的路径');
    return;
  }
  let st;
  try {
    st = await stat(target);
  } catch {
    fail(res, 404, `素材不存在: ${id}`);
    return;
  }
  if (!st.isFile()) {
    fail(res, 400, `路径不是文件: ${id}`);
    return;
  }
  // assetId 内容寻址、不可变 —— 可长缓存。
  res.writeHead(200, {
    'Content-Type': guessMime(id),
    'Content-Length': String(st.size),
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
  const stream = createReadStream(target);
  stream.on('error', (err) => {
    console.error('[board-server] 读取素材流出错:', err);
    if (!res.headersSent) fail(res, 500, `读取素材失败: ${errMsg(err)}`);
    else res.destroy();
  });
  stream.pipe(res);
}

/**
 * POST /api/assets —— 上传画布素材（图片）到 assets/，返回新 assetId。
 * 请求体为原始图片字节，`Content-Type` 标明 MIME。
 */
async function handleUploadAsset(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const mime = (req.headers['content-type'] ?? '')
    .split(';')[0]!
    .trim()
    .toLowerCase();
  if (!mime.startsWith('image/')) {
    fail(res, 415, '仅支持上传图片素材');
    return;
  }
  let buf: Buffer;
  try {
    buf = await readBinaryBody(req);
  } catch (err) {
    fail(res, 413, errMsg(err));
    return;
  }
  if (buf.length === 0) {
    fail(res, 400, '上传体为空');
    return;
  }
  const assetsRoot = resolve(deps.dir, 'assets');
  try {
    await mkdir(assetsRoot, { recursive: true });
    const assetId = `${randomUUID().replace(/-/g, '').slice(0, 16)}.${extForImageMime(mime)}`;
    await writeFile(resolve(assetsRoot, assetId), buf);
    ok(res, { assetId, size: buf.length });
  } catch (err) {
    fail(res, 500, `保存素材失败: ${errMsg(err)}`);
  }
}

/**
 * POST /api/files/move —— 把 files/ 下的一个文件移动到新的相对路径。
 *
 * 请求体 `{ from, to, x?, y? }`：from/to 为相对 files/ 的路径。这是
 * 「画布 → 文件系统」方向的同步入口：Web 端拖动文件卡跨区域时调用。
 *
 * 落点 `x,y`（可选）：
 *  - 带落点（Web 拖拽）—— 直接把对应 file 元素改名并定位到该落点，
 *    **保留位置、不自动排布**（类访达：文件停在你松手处）。
 *  - 无落点（如 CLI mv）—— 走 reconcile 自动排布。
 *
 * 约束：
 *  - from / to 解析后必须仍落在 files/ 内（防目录穿越）。
 *  - from 必须是已存在的文件；to 不得已存在（避免静默覆盖）。
 *  - 同步后广播 board-changed，Web 端据 SSE 刷新。
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

  // 可选落点坐标 —— Web 端拖拽传入，用于「保留落点」（不走自动排布）。
  const rawX = (body as Record<string, unknown>)['x'];
  const rawY = (body as Record<string, unknown>)['y'];
  const dropX = typeof rawX === 'number' && Number.isFinite(rawX) ? rawX : null;
  const dropY = typeof rawY === 'number' && Number.isFinite(rawY) ? rawY : null;

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

  // 同步画布
  if (dropX !== null && dropY !== null) {
    // 带落点：把对应 file 元素改名并定位到落点 —— 保留位置，不自动排布。
    try {
      const handle = await loadBoard(deps.dir);
      const hasEl = handle.scene.elements.some(
        (el) => el.type === 'file' && el.path === from,
      );
      if (hasEl) {
        const regions = regionsOf(handle.scene.elements);
        const parent = regionForFile(to, regions);
        const ts = new Date().toISOString();
        const moved = handle.scene.elements.map((el) =>
          el.type === 'file' && el.path === from
            ? {
                ...el,
                path: to,
                x: dropX,
                y: dropY,
                parentId: parent ? parent.id : null,
                autoPlaced: false,
                updatedAt: ts,
              }
            : el,
        );
        // 区域增长以容纳落点处的文件（区域始终包含其内容）
        const grown = growRegions(moved);
        await saveBoard(deps.dir, handle.meta, {
          ...handle.scene,
          elements: grown.elements,
        });
        await deps.recordChange('u_local');
      } else {
        // 该文件尚无对应画布元素 —— 退回 reconcile 兜底。
        await deps.reconcileNow('move');
      }
    } catch (err) {
      fail(res, 500, `移动后同步画布失败: ${errMsg(err)}`);
      return;
    }
  } else {
    // 无落点（如 CLI mv）：reconcile 自动排布。
    await deps.reconcileNow('move');
  }
  ok(res, { from, to });
}

/**
 * POST /api/tasks —— 新建 Agent 任务（Pencil 占位卡，PRD §7.4 / §7.5）。
 *
 * 请求体 `{ title, agentId?, region?, at? }`：
 *  - `region` —— 区域名（label），任务卡置于该区域内部上方；
 *  - `at` —— `[x,y]` 显式画布坐标；
 *  - 二者皆无 —— 落在收件区左上。
 */
async function handleCreateTask(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    fail(res, 400, errMsg(err));
    return;
  }
  if (typeof body !== 'object' || body === null) {
    fail(res, 400, '请求体必须为 JSON 对象');
    return;
  }
  const rec = body as Record<string, unknown>;
  const title = typeof rec['title'] === 'string' ? rec['title'].trim() : '';
  if (!title) {
    fail(res, 400, '缺少任务标题 title');
    return;
  }
  const agentId =
    typeof rec['agentId'] === 'string' && rec['agentId'] ? rec['agentId'] : 'a_agent';

  // 解析任务卡位置：region 名 → 区域内部上方；at → 显式坐标；否则收件区。
  let regionId: string | null = null;
  let x = 40;
  let y = 40;
  const regionName = typeof rec['region'] === 'string' ? rec['region'].trim() : '';
  const at = Array.isArray(rec['at']) ? (rec['at'] as unknown[]) : null;
  if (regionName) {
    try {
      const handle = await loadBoard(deps.dir);
      const region = regionsOf(handle.scene.elements).find(
        (r) => r.label === regionName,
      );
      if (!region) {
        fail(res, 404, `未找到区域：${regionName}`);
        return;
      }
      regionId = region.id;
      x = region.x + 20;
      y = region.y + 56;
    } catch (err) {
      fail(res, 500, `读取白板失败: ${errMsg(err)}`);
      return;
    }
  } else if (at && typeof at[0] === 'number' && typeof at[1] === 'number') {
    x = at[0];
    y = at[1];
  }

  const task = createTask({ title, agentId, regionId, x, y });
  await deps.tasks.put(task);
  deps.emitEvent('agent.task.started', agentId, {
    taskId: task.id,
    title,
    region: regionName || null,
  });
  deps.sse.broadcast({ type: 'board-changed' });
  ok(res, { taskId: task.id, task });
}

/**
 * POST /api/tasks/progress —— 上报任务进度。
 * 请求体 `{ taskId, step?, percent? }`：追加步骤 / 更新进度百分比。
 */
async function handleTaskProgress(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    fail(res, 400, errMsg(err));
    return;
  }
  if (typeof body !== 'object' || body === null) {
    fail(res, 400, '请求体必须为 JSON 对象');
    return;
  }
  const rec = body as Record<string, unknown>;
  const taskId = typeof rec['taskId'] === 'string' ? rec['taskId'] : '';
  const task = deps.tasks.get(taskId);
  if (!task) {
    fail(res, 404, `未找到任务：${taskId}`);
    return;
  }
  const ts = new Date().toISOString();
  const next: BoardTask = { ...task, steps: [...task.steps], updatedAt: ts };
  if (typeof rec['step'] === 'string' && rec['step'].trim()) {
    next.steps.push({ text: rec['step'].trim(), ts });
  }
  if (typeof rec['percent'] === 'number') {
    next.percent = clampPercent(rec['percent']);
  }
  await deps.tasks.put(next);
  deps.emitEvent('agent.task.progress', next.agentId, {
    taskId: next.id,
    step: next.steps[next.steps.length - 1]?.text ?? null,
    percent: next.percent,
  });
  deps.sse.broadcast({ type: 'board-changed' });
  ok(res, { task: next });
}

/**
 * POST /api/tasks/finish —— 完成任务。
 * 请求体 `{ taskId, summary? }`：任务转结果说明态，并把场景中所有 draft 态
 * 元素提交为 committed（PRD §7.4 第 6 点）。
 */
async function handleTaskFinish(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    fail(res, 400, errMsg(err));
    return;
  }
  if (typeof body !== 'object' || body === null) {
    fail(res, 400, '请求体必须为 JSON 对象');
    return;
  }
  const rec = body as Record<string, unknown>;
  const taskId = typeof rec['taskId'] === 'string' ? rec['taskId'] : '';
  const task = deps.tasks.get(taskId);
  if (!task) {
    fail(res, 404, `未找到任务：${taskId}`);
    return;
  }
  const ts = new Date().toISOString();
  const summary =
    typeof rec['summary'] === 'string' && rec['summary'].trim()
      ? rec['summary'].trim()
      : task.summary;
  const next: BoardTask = {
    ...task,
    status: 'done',
    percent: 100,
    summary,
    updatedAt: ts,
  };
  await deps.tasks.put(next);

  // 提交本流程产出的 draft 态元素 → committed。失败不影响任务完成本身。
  let committedChanged = false;
  try {
    const handle = await loadBoard(deps.dir);
    const committed = commitDraftElements(handle.scene, task.agentId);
    if (committed.changed) {
      await saveBoard(deps.dir, handle.meta, committed.scene);
      committedChanged = true;
    }
  } catch (err) {
    console.error('[board-server] task.finish 提交 draft 元素失败:', err);
  }
  deps.emitEvent('agent.task.finished', task.agentId, {
    taskId: next.id,
    summary: next.summary,
  });
  // draft → committed 改了 board.json，比对产出 element.updated 事件并广播；
  // 无 draft 元素时只发 board-changed 即可。
  if (committedChanged) {
    await deps.recordChange(task.agentId);
  } else {
    deps.sse.broadcast({ type: 'board-changed' });
  }
  ok(res, { task: next });
}

/**
 * DELETE /api/tasks/<id> —— 移除一个任务。
 * 用于完成态任务卡的「× 手动关闭」与「超时自动淡出」清理。
 */
async function handleDeleteTask(
  deps: HttpDeps,
  res: ServerResponse,
  id: string,
): Promise<void> {
  if (!id) {
    fail(res, 400, '缺少任务 id');
    return;
  }
  if (!deps.tasks.get(id)) {
    fail(res, 404, `未找到任务：${id}`);
    return;
  }
  await deps.tasks.remove(id);
  deps.sse.broadcast({ type: 'board-changed' });
  ok(res, { removed: id });
}

/**
 * POST /api/refresh —— 外部写入后主动触发同步。
 *
 * 供「绕过 server 直接改 .board 的外部写入方」（如 CLI / MCP Server 的内容操作）
 * 在写入 board.json 后调用：比对场景产出事件流、并广播 board-changed 让 Web
 * 实时刷新。请求体可选 `{ actor }` —— 带上则事件归因更准，省略默认 `u_local`。
 */
async function handleRefresh(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let actor = 'u_local';
  try {
    const body = await readJsonBody(req);
    if (typeof body === 'object' && body !== null) {
      const a = (body as Record<string, unknown>)['actor'];
      if (typeof a === 'string' && a) actor = a;
    }
  } catch {
    // refresh 允许空请求体 —— 用默认 actor。
  }
  // 外部写入（CLI / MCP）可能往区域里加了元素（如 Agent 在区域内画流程图）——
  // 自动增长区域以包住内容。growRegions 是 grow-only、幂等的，安全可常跑。
  try {
    const handle = await loadBoard(deps.dir);
    const grown = growRegions(handle.scene.elements);
    if (grown.changed) {
      await saveBoard(deps.dir, handle.meta, {
        ...handle.scene,
        elements: grown.elements,
      });
    }
  } catch (err) {
    console.error('[board-server] refresh 增长区域失败:', errMsg(err));
  }
  await deps.recordChange(actor);
  ok(res, { refreshed: true });
}

/**
 * POST /api/suggestions/<op> —— 处理一条建议（M3：建议机制，PRD §7.3）。
 *
 * `op` ∈ {accept, reject, describe}，请求体 `{ suggestionId, actor?, text? }`：
 *  - accept   —— 同意：replace 替换目标内容 / add 新增元素，移除建议元素。
 *  - reject   —— 拒绝：删除建议元素，原件不变。
 *  - describe —— 描述：向建议追加一条反馈（需 `text`），建议元素保留。
 *
 * 三种操作都是「人对建议的决策」，default actor 取本地人类用户 `u_local`。
 * 操作后落盘 board.json 并广播 board-changed，Web 端据 SSE 刷新。
 */
async function handleSuggestionOp(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  op: 'accept' | 'reject' | 'describe',
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    fail(res, 400, errMsg(err));
    return;
  }
  if (typeof body !== 'object' || body === null) {
    fail(res, 400, '请求体必须为 JSON 对象');
    return;
  }
  const rec = body as Record<string, unknown>;
  const suggestionId =
    typeof rec['suggestionId'] === 'string' ? rec['suggestionId'] : '';
  if (!suggestionId) {
    fail(res, 400, '缺少 suggestionId');
    return;
  }
  const actor =
    typeof rec['actor'] === 'string' && rec['actor'] ? rec['actor'] : 'u_local';

  let handle;
  try {
    handle = await loadBoard(deps.dir);
  } catch (err) {
    fail(res, 404, `读取白板失败: ${errMsg(err)}`);
    return;
  }

  let result: SuggestionResult;
  if (op === 'accept') {
    result = acceptSuggestion(handle.scene, suggestionId, actor);
  } else if (op === 'reject') {
    result = rejectSuggestion(handle.scene, suggestionId);
  } else {
    const text = typeof rec['text'] === 'string' ? rec['text'].trim() : '';
    if (!text) {
      fail(res, 400, '描述内容 text 不能为空');
      return;
    }
    result = describeSuggestion(handle.scene, suggestionId, text, actor, 'human');
  }

  if (result.error) {
    // 目标元素已不存在视为冲突（409），建议本身找不到视为未找到（404）。
    fail(res, result.error.includes('目标元素已不存在') ? 409 : 404, result.error);
    return;
  }
  if (result.changed) {
    try {
      await saveBoard(deps.dir, handle.meta, result.scene);
    } catch (err) {
      fail(res, 500, `保存白板失败: ${errMsg(err)}`);
      return;
    }
  }
  // 语义事件 —— accept/reject/describe 的意图无法由场景 diff 还原，直接发。
  const semantic: BoardEventType =
    op === 'accept'
      ? 'suggestion.accepted'
      : op === 'reject'
        ? 'suggestion.rejected'
        : 'suggestion.commented';
  deps.emitEvent(semantic, actor, { suggestionId });
  // 再比对场景，产出建议元素移除 / 目标更新等 element.* 事件并广播 board-changed。
  await deps.recordChange(actor);
  ok(res, { suggestionId, op });
}

/**
 * POST /api/elements/delete —— 删除一个元素。
 *
 * 请求体 `{ elementId }`。与 CLI `board rm` 同语义（specs §2.2）：
 *  - `file` 元素：真实文件移入回收站 `.runtime/trash/`（可恢复）。
 *  - 连带清理引用它的连线 / 建议（避免悬空，经 core `removeElement`）。
 *  - `region` / `folder` 背后是真实文件夹，拒绝删除。
 *
 * Web 画布删除 file 元素必须经此端点 —— 仅改内存场景的话，文件仍在磁盘上，
 * 下次 reconcile 会按磁盘文件把它复活。
 */
async function handleDeleteElement(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    fail(res, 400, errMsg(err));
    return;
  }
  if (typeof body !== 'object' || body === null) {
    fail(res, 400, '请求体必须为 { elementId }');
    return;
  }
  const rawId = (body as Record<string, unknown>)['elementId'];
  const elementId = typeof rawId === 'string' ? rawId : '';
  if (!elementId) {
    fail(res, 400, '缺少 elementId');
    return;
  }
  const rawActor = (body as Record<string, unknown>)['actor'];
  const actor = typeof rawActor === 'string' && rawActor ? rawActor : 'u_local';

  let handle;
  try {
    handle = await loadBoard(deps.dir);
  } catch (err) {
    fail(res, 404, `读取白板失败: ${errMsg(err)}`);
    return;
  }
  const target = handle.scene.elements.find((e) => e.id === elementId);
  if (!target) {
    fail(res, 404, `未找到元素：${elementId}`);
    return;
  }
  if (target.type === 'region' || target.type === 'folder') {
    fail(
      res,
      400,
      `不支持删除 ${target.type} 元素（其背后是真实文件夹，请直接操作文件夹）`,
    );
    return;
  }

  // 移除元素 + 连带清理引用（与 board rm 同源逻辑），先落盘。
  // 顺序要点：必须**先**存好「不含该元素」的 board.json，**再**动真实文件。
  // 若先 trash 文件，watcher 会在文件消失瞬间 reconcile —— 那时 board.json
  // 还留着这个 file 元素、磁盘文件却没了，reconcile 会把它当 R6 缺失态保留
  // 并回写，反过来覆盖掉本次删除。先存后删，reconcile 随后只会看到「无元素、
  // 无文件」的一致状态，不再复活。
  const { scene: next, removedRefs } = removeElement(handle.scene, elementId);
  try {
    await saveBoard(deps.dir, handle.meta, next);
  } catch (err) {
    fail(res, 500, `保存白板失败: ${errMsg(err)}`);
    return;
  }

  // file 元素：真实文件移入回收站 .runtime/trash/（可恢复）。
  let trashedFile: string | null = null;
  if (target.type === 'file') {
    const src = join(deps.dir, 'files', target.path);
    try {
      await stat(src);
      const trashDir = join(deps.dir, '.runtime', 'trash');
      await mkdir(trashDir, { recursive: true });
      await rename(src, join(trashDir, `${Date.now()}-${basename(target.path)}`));
      trashedFile = target.path;
    } catch {
      // 文件已不在磁盘上 —— 只删元素即可。
    }
  }

  // 比对场景产出 element.deleted / file.deleted（含连带清理的连线 / 建议）事件。
  await deps.recordChange(actor);
  ok(res, { removed: elementId, type: target.type, trashedFile, removedRefs });
}

/**
 * POST /api/presence —— 上报在场光标 / 显式离开（M4：拟人化光标，PRD §8.2）。
 *
 * 请求体 `{ clientId, name?, color?, cursor?, leaving? }`：
 *  - `leaving: true` —— 显式离开（tab 关闭，多经 sendBeacon）→ 移除并广播
 *    `presence-leave`；
 *  - 否则 —— 登记 / 刷新该客户端，广播 `presence` 帧。`cursor` 为画布坐标
 *    `{x,y}`，省略 / 非法时记为 null（在场但光标未知）。
 *
 * Presence 是纯瞬时态：不落 board.json、不进事件日志、不触发 recordChange。
 */
function handlePresence(
  deps: HttpDeps,
  body: unknown,
  res: ServerResponse,
): void {
  if (typeof body !== 'object' || body === null) {
    fail(res, 400, '请求体必须为 JSON 对象');
    return;
  }
  const rec = body as Record<string, unknown>;
  const clientId = typeof rec['clientId'] === 'string' ? rec['clientId'] : '';
  if (!clientId) {
    fail(res, 400, '缺少 clientId');
    return;
  }
  if (rec['leaving'] === true) {
    if (deps.presence.remove(clientId)) {
      const leaveFrame = { type: 'presence-leave', clientId };
      deps.sse.broadcast(leaveFrame);
    }
    ok(res, { left: clientId });
    return;
  }
  const name =
    typeof rec['name'] === 'string' && rec['name'] ? rec['name'] : '协作者';
  const color =
    typeof rec['color'] === 'string' && rec['color'] ? rec['color'] : '#868e96';
  const rawCursor = rec['cursor'];
  let cursor: { x: number; y: number } | null = null;
  if (typeof rawCursor === 'object' && rawCursor !== null) {
    const c = rawCursor as Record<string, unknown>;
    if (
      typeof c['x'] === 'number' &&
      typeof c['y'] === 'number' &&
      Number.isFinite(c['x']) &&
      Number.isFinite(c['y'])
    ) {
      cursor = { x: c['x'], y: c['y'] };
    }
  }
  const entry = deps.presence.update({ clientId, name, color, cursor });
  const frame = { type: 'presence', client: entry };
  deps.sse.broadcast(frame);
  ok(res, { ok: true });
}

/**
 * GET /api/events —— SSE 长连接。多类帧共享此通道：
 *  - `board-changed` —— Web 据此整板刷新；
 *  - `ops` —— Web 据此增量合并（M4 实时同步）；
 *  - `presence` / `presence-leave` —— 在场光标更新 / 离开（M4）；
 *  - 结构化 `BoardEvent`（带 `seq`）—— `board watch` 据此输出事件流。
 */
function handleEvents(deps: HttpDeps, req: IncomingMessage, res: ServerResponse): void {
  deps.sse.handle(req, res);
}

/**
 * GET /api/events/log?since=<seq>&region=<名> —— 按游标增量拉取留存事件。
 *
 * 供 MCP `board_subscribe_events` 轮询：传上次拿到的 `cursor`，取其后的新事件。
 * `region` 可选 —— 只返回 payload.region 命中该区域的事件。
 */
function handleEventLog(deps: HttpDeps, res: ServerResponse, url: URL): void {
  const sinceRaw = url.searchParams.get('since');
  const since =
    sinceRaw !== null && sinceRaw !== '' && Number.isFinite(Number(sinceRaw))
      ? Number(sinceRaw)
      : 0;
  const region = url.searchParams.get('region');
  let list = deps.events.since(since);
  if (region) {
    list = list.filter((e) => e.payload['region'] === region);
  }
  ok(res, { events: list, cursor: deps.events.cursor() });
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
  // POST /api/ops —— 操作级实时同步（M4）
  if (path === '/api/ops' && method === 'POST') {
    await handleApplyOps(deps, req, res);
    return;
  }
  // POST /api/presence —— 在场光标上报（M4）
  if (path === '/api/presence' && method === 'POST') {
    let presenceBody: unknown;
    try {
      presenceBody = await readJsonBody(req);
    } catch (err) {
      fail(res, 400, errMsg(err));
      return;
    }
    handlePresence(deps, presenceBody, res);
    return;
  }
  // GET /api/events/log —— 事件增量拉取；须先于 /api/events 判断
  if (path === '/api/events/log' && method === 'GET') {
    handleEventLog(deps, res, url);
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
  // POST /api/tasks* —— Agent 任务（Pencil 式过程可视化，PRD §7.4）
  if (path === '/api/tasks' && method === 'POST') {
    await handleCreateTask(deps, req, res);
    return;
  }
  if (path === '/api/tasks/progress' && method === 'POST') {
    await handleTaskProgress(deps, req, res);
    return;
  }
  if (path === '/api/tasks/finish' && method === 'POST') {
    await handleTaskFinish(deps, req, res);
    return;
  }
  // DELETE /api/tasks/<id> —— 移除任务（× 关闭 / 超时清理）
  if (path.startsWith('/api/tasks/') && method === 'DELETE') {
    await handleDeleteTask(deps, res, path.slice('/api/tasks/'.length));
    return;
  }
  // POST /api/refresh —— 外部写入后主动触发同步（事件流 + board-changed）
  if (path === '/api/refresh' && method === 'POST') {
    await handleRefresh(deps, req, res);
    return;
  }
  // POST /api/suggestions/<op> —— 建议机制三操作（M3，PRD §7.3）
  if (path === '/api/suggestions/accept' && method === 'POST') {
    await handleSuggestionOp(deps, req, res, 'accept');
    return;
  }
  if (path === '/api/suggestions/reject' && method === 'POST') {
    await handleSuggestionOp(deps, req, res, 'reject');
    return;
  }
  if (path === '/api/suggestions/describe' && method === 'POST') {
    await handleSuggestionOp(deps, req, res, 'describe');
    return;
  }
  // POST /api/elements/delete —— 删除元素（含 file 移入回收站、连带清引用）
  if (path === '/api/elements/delete' && method === 'POST') {
    await handleDeleteElement(deps, req, res);
    return;
  }
  // POST /api/assets —— 上传画布素材；GET /api/assets/<id> —— 读取素材
  if (path === '/api/assets' && method === 'POST') {
    await handleUploadAsset(deps, req, res);
    return;
  }
  if (path.startsWith('/api/assets/') && method === 'GET') {
    const rawPath = url.pathname;
    await handleGetAsset(deps, res, rawPath.slice('/api/assets/'.length));
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
