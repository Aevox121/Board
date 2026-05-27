/**
 * HTTP API — Node 内置 `node:http`，host 固定 127.0.0.1（PRD §12 安全）。
 *
 * 统一响应信封：`{ ok, data, error }`（见 specs/CLI与MCP规格.md §1.3）。
 *
 * 端点：
 *  - GET  /api/health           → 服务状态（M1）
 *  - GET  /api/board            → { meta, scene, files }（M1）
 *  - PUT  /api/board            → 请求体 { scene } → Y.Doc 整场景写入（M1）
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
 *  - POST /api/elements/text-set → 整体替换 text 元素 markdown（Y.Text reset）
 *  - POST /api/elements/delete  → 删除元素（file 移入回收站、连带清引用）
 *  - GET  /api/events           → SSE，board-changed + 结构化事件流（M2/M4）
 *  - GET  /api/events/log       → 按游标增量拉取留存事件（M4：事件流）
 */
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { basename, dirname, join, resolve, sep } from 'node:path';
import * as Y from 'yjs';
import {
  acceptSuggestion,
  clampPercent,
  commitDraftElements,
  computeEditAnchor,
  createRegionElement,
  createTask,
  createTextElement,
  describeSuggestion,
  growRegions,
  guessMime,
  nextZ,
  normalizePath,
  regionForFile,
  regionsOf,
  rejectSuggestion,
  removeElement,
  SCHEMA_VERSION,
  type BoardEventType,
  type BoardMeta,
  type BoardScene,
  type BoardTask,
  type SuggestionResult,
} from '@board/core';
import type { EventLog } from './events.js';
import type { OpLog } from './oplog.js';
import type { PresenceHub } from './presence.js';
import {
  createSnapshot,
  deleteSnapshot,
  listSnapshots,
  restoreSnapshot,
} from './snapshots.js';
import type { SseHub } from './sse.js';
import type { TaskStore } from './tasks.js';
import type { YjsRoom } from './yjs-room.js';

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
   * 比对 Y.Doc 当前场景与基线场景，产出 element / file / region 类事件并
   * 广播；末尾广播 board-changed。所有 room.mutate 后调用。
   */
  recordChange(actor: string): Promise<void>;
  /** 直接发出一条结构化事件（task 等非 board.json 来源用）。 */
  emitEvent(
    type: BoardEventType,
    actor: string,
    payload: Record<string, unknown>,
  ): void;
  /** 操作日志 —— PRD §6.9 `history/oplog.jsonl`。 */
  opLog: OpLog;
  /** Yjs 房间 —— 权威 Y.Doc，所有场景读写经此（M4 增量2）。 */
  room: YjsRoom;
  /** 当前 meta。 */
  getMeta(): BoardMeta;
  /** 替换当前 meta（快照创建 / 删除 / 复原后调用 —— meta.snapshots 改变）。 */
  setMeta(next: BoardMeta): void;
  /** 暂停文件监听（快照复原期间整盘换 files/ 用）。 */
  pauseWatcher(): void;
  /** 恢复文件监听 + 把内存集合对齐到磁盘当前实际文件。 */
  resumeWatcher(currentDiskFiles: string[]): void;
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

/**
 * 取当前白板快照（M4 增量2 起：从 Y.Doc 投影，不再 loadBoard）。
 *
 * 同步 / 无 IO —— 各 handler 调用此函数代替 `await loadBoard(deps.dir)`。
 * scene 来自 room.getScene()（yDocToScene 的实时投影），meta 是启动期捕获
 * 的不可变副本。
 */
function readSnapshot(deps: HttpDeps): { meta: BoardMeta; scene: BoardScene } {
  return { meta: deps.getMeta(), scene: deps.room.getScene() };
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
function handleGetBoard(deps: HttpDeps, res: ServerResponse): void {
  const snap = readSnapshot(deps);
  ok(res, {
    meta: snap.meta,
    scene: snap.scene,
    files: deps.getFiles(),
    tasks: deps.tasks.list(),
  });
}

/** PUT /api/board —— 请求体 { scene }，整场景写入 Y.Doc 后返回 { ok }。 */
async function handlePutBoard(
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

  if (typeof body !== 'object' || body === null || !('scene' in body)) {
    fail(res, 400, '请求体必须为 { scene: BoardScene }');
    return;
  }
  const scene = (body as { scene: unknown }).scene;
  if (!isBoardScene(scene)) {
    fail(res, 400, 'scene 字段结构非法（需含 schemaVersion / viewport / elements）');
    return;
  }

  // 经 Y.Doc 落地 —— mutator 直接返回新场景，room 内部 diff 出最小 op 集
  // 写入 Y.Doc；observer 节流投影回 board.json，并 ws 广播给所有客户端。
  deps.room.mutate('u_local', () => scene);
  await deps.recordChange('u_local');
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
 * POST /api/files/upload?path=<相对路径>[&overwrite=1] —— 把请求体字节写入 files/<path>。
 *
 * 请求体：原始字节；Content-Type 任意（仅用于回显，不参与决策）。
 * `?path=` 是 files/ 下的目标相对路径（含文件名），用 `/` 分隔；server 防
 * 目录穿越（resolve 后必须仍在 files/ 内）。
 *
 * 默认行为：拒绝覆盖既有同名文件（避免拖入文件时静默丢失）。
 * `?overwrite=1`：允许覆盖既有同名文件（FileCard 就地编辑保存走这条路径，
 * 写回是用户主动行为而非误触）；目标若是目录仍拒绝。
 *
 * 落盘后立即跑一次 reconcile：watcher 同步路径的同时也会经 reconcile 在
 * scene 里建出 file 元素（含 region 归属自动判定）；编辑覆写场景下文件已
 * 存在、reconcile 仅刷新 updatedAt，scene 元素本体不变。
 */
async function handleFileUpload(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const targetRaw = url.searchParams.get('path')?.trim() ?? '';
  if (!targetRaw) {
    fail(res, 400, '缺少 ?path=<files/ 下的相对路径>');
    return;
  }
  const overwrite = url.searchParams.get('overwrite') === '1';
  // 规范化 + 拒绝穿越。
  const target = targetRaw.replace(/\\/g, '/').replace(/^\/+/, '');
  if (
    target === '' ||
    target.endsWith('/') ||
    target.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')
  ) {
    fail(res, 400, `非法 path: ${targetRaw}`);
    return;
  }
  const filesRoot = resolve(deps.dir, 'files');
  const full = resolve(filesRoot, target);
  if (full !== filesRoot && !full.startsWith(filesRoot + sep)) {
    fail(res, 400, 'path 越出 files/');
    return;
  }
  // 已存在性判断 —— overwrite 时只拒绝「目标是目录」，否则按既往拒绝覆盖。
  try {
    const st = await stat(full);
    if (st.isDirectory()) {
      fail(res, 409, `目标是目录，无法写文件: ${target}`);
      return;
    }
    if (!overwrite) {
      fail(res, 409, `目标已存在: ${target}`);
      return;
    }
  } catch {
    // ENOENT —— 正常路径，继续。
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

  try {
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, buf);
  } catch (err) {
    fail(res, 500, `写文件失败: ${errMsg(err)}`);
    return;
  }
  // 立刻 reconcile —— 不必等 chokidar 防抖窗口；reconcile 会建出 file 元素 +
  // 按 path 自动落入所属区域（fs-mapping）。
  try {
    await deps.reconcileNow('upload');
  } catch (err) {
    console.error('[upload] reconcile 失败:', err);
  }
  ok(res, { path: target, size: buf.length });
}

/**
 * POST /api/regions —— 在画布上创建一个区域。
 *
 * 区域本质是 files/ 下的文件夹（规格 R1）：建 `files/<name>/` 目录 +
 * 写描述 README.md，并在 board.json 追加一个 region 元素（位置 / 尺寸由
 * 画布拖拽给定）。落盘后 reconcile 同步并广播，各端经 SSE 重载。
 */
async function handleCreateRegion(
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
  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b['name'] === 'string' ? b['name'].trim() : '';
  if (!name) {
    fail(res, 400, '缺少区域名');
    return;
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    fail(res, 400, '区域名不能包含路径分隔符或 ".."');
    return;
  }
  const num = (v: unknown, d: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : d;
  const x = num(b['x'], 0);
  const y = num(b['y'], 0);
  const width = Math.max(120, num(b['width'], 360));
  const height = Math.max(80, num(b['height'], 240));
  const description =
    typeof b['description'] === 'string' ? b['description'] : '';
  const actor = typeof b['actor'] === 'string' ? b['actor'] : 'u_local';

  const handle = readSnapshot(deps);
  if (regionsOf(handle.scene.elements).some((r) => r.path === name)) {
    fail(res, 409, `区域已存在: ${name}`);
    return;
  }
  const regionDir = resolve(deps.dir, 'files', name);
  let dirExists = true;
  try {
    await stat(regionDir);
  } catch {
    dirExists = false;
  }
  if (dirExists) {
    fail(res, 409, `目标文件夹已存在: files/${name}`);
    return;
  }
  try {
    await mkdir(regionDir, { recursive: true });
    await writeFile(join(regionDir, 'README.md'), description, 'utf8');
  } catch (err) {
    fail(res, 500, `创建区域文件夹失败: ${errMsg(err)}`);
    return;
  }
  const element = createRegionElement({
    x,
    y,
    width,
    height,
    createdBy: actor,
    z: nextZ(handle.scene.elements),
    autoPlaced: false,
    path: name,
    label: name,
    description,
  });

  // 框选范围内的顶层元素（parentId 为空）归入新区域：
  //  - 图形 / 手绘 / 文本 / 图片 / 嵌入 → 仅改 parentId；
  //  - 文件 → 移入 files/<name>/，更新 path + parentId；
  //  - 区域 / 文件夹 → 文件夹移入 files/<name>/，自身与全部后代 path 加
  //    前缀，自身 parentId 指向新区域（即成为子区域）。连线 / 建议不纳入。
  const inRegion = (e: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): boolean => {
    const ecx = e.x + e.width / 2;
    const ecy = e.y + e.height / 2;
    return ecx >= x && ecx <= x + width && ecy >= y && ecy <= y + height;
  };
  const baseOf = (p: string): string => {
    const n = normalizePath(p);
    const i = n.lastIndexOf('/');
    return i >= 0 ? n.slice(i + 1) : n;
  };
  const pathPatch = new Map<string, string>();
  const parentPatch = new Map<string, string>();
  for (const e of handle.scene.elements) {
    if (e.parentId != null) continue;
    if (e.type === 'connector' || e.type === 'suggestion') continue;
    if (!inRegion(e)) continue;
    if (e.type === 'region' || e.type === 'folder') {
      const oldP = normalizePath(e.path);
      if (!oldP) continue;
      try {
        await rename(
          resolve(deps.dir, 'files', oldP),
          resolve(deps.dir, 'files', name, oldP),
        );
      } catch {
        continue; // 文件夹缺失 / 目标冲突 —— 跳过该项
      }
      // 自身与全部后代（path 在 oldP 下）重设路径前缀。
      for (const d of handle.scene.elements) {
        const raw = (d as { path?: unknown }).path;
        if (typeof raw !== 'string') continue;
        const dp = normalizePath(raw);
        if (dp === oldP || dp.startsWith(`${oldP}/`)) {
          pathPatch.set(d.id, `${name}/${dp}`);
        }
      }
      parentPatch.set(e.id, element.id);
    } else if (e.type === 'file') {
      const base = baseOf(e.path);
      try {
        await stat(resolve(deps.dir, 'files', name, base));
        continue; // 目标已存在 —— 跳过
      } catch {
        // 目标不存在，可移入
      }
      try {
        await rename(
          resolve(deps.dir, 'files', normalizePath(e.path)),
          resolve(deps.dir, 'files', name, base),
        );
      } catch {
        continue;
      }
      pathPatch.set(e.id, `${name}/${base}`);
      parentPatch.set(e.id, element.id);
    } else {
      parentPatch.set(e.id, element.id);
    }
  }

  const ts = new Date().toISOString();
  const nextElements = handle.scene.elements.map((e) => {
    const np = pathPatch.get(e.id);
    const npar = parentPatch.get(e.id);
    if (np === undefined && npar === undefined) return e;
    const patched = { ...e, updatedBy: actor, updatedAt: ts };
    if (np !== undefined) (patched as { path: string }).path = np;
    if (npar !== undefined) patched.parentId = npar;
    return patched;
  });
  nextElements.push(element);
  try {
    deps.room.mutate(actor, () => ({
      ...handle.scene,
      elements: nextElements,
    }));
    await deps.recordChange(actor);
  } catch (err) {
    fail(res, 500, `写入区域失败: ${errMsg(err)}`);
    return;
  }
  // Agent presence —— 围绕新建区域转一下（PRD §7.4 / §8.2）
  pushAgentPresence(deps, actor, element.id);
  ok(res, {
    elementId: element.id,
    path: element.path,
    adopted: parentPatch.size,
  });
}

/**
 * POST /api/regions/reparent —— 把一个区域移入另一个区域（成为子区域）或
 * 移回顶层。文件夹随之移动、自身与全部后代 path 重设前缀、parentId 改写,
 * 并对整个子树应用拖拽位移 (offsetX/offsetY)。
 */
async function handleReparentRegion(
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
  const b = (body ?? {}) as Record<string, unknown>;
  const regionId = typeof b['regionId'] === 'string' ? b['regionId'] : '';
  if (!regionId) {
    fail(res, 400, '缺少 regionId');
    return;
  }
  const parentId = typeof b['parentId'] === 'string' ? b['parentId'] : null;
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : 0;
  const offsetX = num(b['offsetX']);
  const offsetY = num(b['offsetY']);
  const actor = typeof b['actor'] === 'string' ? b['actor'] : 'u_local';

  const handle = readSnapshot(deps);
  const elements = handle.scene.elements;
  const region = elements.find(
    (e) => e.id === regionId && e.type === 'region',
  );
  if (!region) {
    fail(res, 404, `未找到区域：${regionId}`);
    return;
  }
  const oldPath = normalizePath((region as { path: string }).path);

  // 子树：路径在区域下 + parentId 链可达区域。
  const subtree = new Set<string>([region.id]);
  for (const e of elements) {
    const raw = (e as { path?: unknown }).path;
    if (typeof raw === 'string') {
      const p = normalizePath(raw);
      if (p === oldPath || p.startsWith(`${oldPath}/`)) subtree.add(e.id);
    }
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of elements) {
      if (!subtree.has(e.id) && e.parentId && subtree.has(e.parentId)) {
        subtree.add(e.id);
        grew = true;
      }
    }
  }

  // 收编区域内的游离元素 —— parentId 为空、中心落在区域矩形内的图形 /
  // 手绘 / 文本 / 图片 / 嵌入：它们「画在区域里却没归属」，区域移动时
  // 本会被甩在原地，故一并纳入子树并归属该区域。
  const ADOPTABLE: ReadonlySet<string> = new Set([
    'shape',
    'draw',
    'text',
    'image',
    'embed',
  ]);
  const adopted = new Set<string>();
  for (const e of elements) {
    if (e.parentId != null || subtree.has(e.id) || !ADOPTABLE.has(e.type)) {
      continue;
    }
    const ecx = e.x + e.width / 2;
    const ecy = e.y + e.height / 2;
    if (
      ecx >= region.x &&
      ecx <= region.x + region.width &&
      ecy >= region.y &&
      ecy <= region.y + region.height
    ) {
      adopted.add(e.id);
      subtree.add(e.id);
    }
  }

  let parentPath = '';
  if (parentId) {
    const parent = elements.find(
      (e) => e.id === parentId && e.type === 'region',
    );
    if (!parent) {
      fail(res, 404, `未找到目标区域：${parentId}`);
      return;
    }
    if (subtree.has(parentId)) {
      fail(res, 400, '不能把区域移入自身或其子区域');
      return;
    }
    parentPath = normalizePath((parent as { path: string }).path);
  }

  const seg = oldPath.slice(oldPath.lastIndexOf('/') + 1);
  const newPath = parentPath ? `${parentPath}/${seg}` : seg;
  if (newPath !== oldPath) {
    try {
      await stat(resolve(deps.dir, 'files', newPath));
      fail(res, 409, `目标已存在: files/${newPath}`);
      return;
    } catch {
      // 目标不存在，可移动
    }
    try {
      await rename(
        resolve(deps.dir, 'files', oldPath),
        resolve(deps.dir, 'files', newPath),
      );
    } catch (err) {
      fail(res, 500, `移动区域文件夹失败: ${errMsg(err)}`);
      return;
    }
  }

  const ts = new Date().toISOString();
  const next = elements.map((e) => {
    if (!subtree.has(e.id)) return e;
    const patched = {
      ...e,
      x: e.x + offsetX,
      y: e.y + offsetY,
      updatedBy: actor,
      updatedAt: ts,
    };
    const raw = (e as { path?: unknown }).path;
    if (typeof raw === 'string') {
      const p = normalizePath(raw);
      (patched as { path: string }).path = newPath + p.slice(oldPath.length);
    }
    if (e.id === region.id) patched.parentId = parentId;
    else if (adopted.has(e.id)) patched.parentId = region.id;
    return patched;
  });
  try {
    deps.room.mutate(actor, () => ({
      ...handle.scene,
      elements: next,
    }));
    await deps.recordChange(actor);
  } catch (err) {
    fail(res, 500, `写入区域失败: ${errMsg(err)}`);
    return;
  }
  ok(res, { regionId: region.id, path: newPath });
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
      const handle = readSnapshot(deps);
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
        const grown = growRegions(moved);
        deps.room.mutate('u_local', () => ({
          ...handle.scene,
          elements: grown.elements,
        }));
        await deps.recordChange('u_local');
        // R6 修复：把 watcher 内存集 + /api/board files 列表对齐到磁盘
        // 实情；否则 web 端 missingFileIds 会用旧文件列表把这个刚移过来
        // 的文件误判为「文件已不在磁盘上」。reconcile 是幂等的，scene
        // 已是 newPath、disk 也是 newPath，不会再产生 element 改动。
        await deps.reconcileNow('move');
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
    const handle = readSnapshot(deps);
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
  // Agent presence —— 围绕任务所在区域转（无 region 时不画轨道）
  pushAgentPresence(deps, agentId, regionId);
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
  // Agent presence —— 任务进度时刷新 Agent 焦点（围绕任务区域转）
  pushAgentPresence(deps, next.agentId, next.regionId);
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
    const handle = readSnapshot(deps);
    const committed = commitDraftElements(handle.scene, task.agentId);
    if (committed.changed) {
      deps.room.mutate(task.agentId, () => committed.scene);
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
  // Agent presence —— 任务完成时再围绕区域转一圈，最后由 STALE_MS 自然消退
  pushAgentPresence(deps, task.agentId, next.regionId);
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
    const handle = readSnapshot(deps);
    const grown = growRegions(handle.scene.elements);
    if (grown.changed) {
      deps.room.mutate(actor, () => ({
        ...handle.scene,
        elements: grown.elements,
      }));
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

  const handle = readSnapshot(deps);

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
      deps.room.mutate(actor, () => result.scene);
    } catch (err) {
      fail(res, 500, `写入白板失败: ${errMsg(err)}`);
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

  const handle = readSnapshot(deps);
  const target = handle.scene.elements.find((e) => e.id === elementId);
  if (!target) {
    fail(res, 404, `未找到元素：${elementId}`);
    return;
  }
  if (target.type === 'folder') {
    fail(
      res,
      400,
      '不支持删除 folder 元素（其背后是真实文件夹，请直接操作文件夹）',
    );
    return;
  }
  if (target.type === 'region') {
    // 区域级联删除：移除区域 + 其子树（路径在区域下 + parentId 链可达），
    // 端点落在被删元素上的连线一并清掉；区域文件夹移入回收站（可恢复）。
    const rp = normalizePath(target.path);
    const remove = new Set<string>([target.id]);
    for (const e of handle.scene.elements) {
      const raw = (e as { path?: unknown }).path;
      if (typeof raw === 'string') {
        const p = normalizePath(raw);
        if (p === rp || p.startsWith(`${rp}/`)) remove.add(e.id);
      }
    }
    let grew = true;
    while (grew) {
      grew = false;
      for (const e of handle.scene.elements) {
        if (!remove.has(e.id) && e.parentId && remove.has(e.parentId)) {
          remove.add(e.id);
          grew = true;
        }
      }
    }
    const next = handle.scene.elements.filter((e) => {
      if (remove.has(e.id)) return false;
      if (e.type === 'connector') {
        const s = e.start.elementId;
        const t = e.end.elementId;
        if ((s && remove.has(s)) || (t && remove.has(t))) return false;
      }
      return true;
    });
    try {
      deps.room.mutate(actor, () => ({
        ...handle.scene,
        elements: next,
      }));
    } catch (err) {
      fail(res, 500, `写入白板失败: ${errMsg(err)}`);
      return;
    }
    let trashedFolder: string | null = null;
    if (rp) {
      const src = resolve(deps.dir, 'files', rp);
      let onDisk = true;
      try {
        await stat(src);
      } catch {
        onDisk = false; // 文件夹已不在磁盘上 —— 仅删元素。
      }
      if (onDisk) {
        const trashDir = resolve(deps.dir, '.runtime', 'trash');
        const seg = rp.slice(rp.lastIndexOf('/') + 1);
        const dest = resolve(trashDir, `${Date.now()}-${seg}`);
        try {
          await mkdir(trashDir, { recursive: true });
          // 先尝试整体 rename（最快）；失败（如 Windows 监听句柄占用含子目录
          // 的目录树）则回退为递归复制后递归删除。
          try {
            await rename(src, dest);
          } catch {
            await cp(src, dest, { recursive: true });
            await rm(src, { recursive: true, force: true });
          }
          trashedFolder = rp;
        } catch (err) {
          console.error(
            `[board-server] 区域文件夹移入回收站失败 (${rp}):`,
            err,
          );
        }
      }
    }
    await deps.recordChange(actor);
    ok(res, {
      removed: target.id,
      type: 'region',
      removedCount: remove.size,
      trashedFolder,
    });
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
    deps.room.mutate(actor, () => next);
  } catch (err) {
    fail(res, 500, `写入白板失败: ${errMsg(err)}`);
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
 * POST /api/elements/text-create —— 创建一个 text 元素（流式工作流的起手）。
 *
 * 与 CLI `board add text` 不同：本端点经 Y.Doc 写入而非 fs direct，且专门
 * 为「先创建空卡 → 多次 text-append 流式追加」设计。返回 elementId。
 *
 * 请求体：`{ actor, x?, y?, width?, height?, markdown?, region? }`
 *  - region：可选，指定区域名，元素归属该区域；x/y 解读为相对区域左上的偏移
 *  - 不传 region：x/y 为画布绝对坐标
 */
async function handleTextCreate(
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
  const actor = typeof rec['actor'] === 'string' ? rec['actor'] : 'u_local';
  const num = (v: unknown, d: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : d;
  let x = num(rec['x'], 0);
  let y = num(rec['y'], 0);
  const width = Math.max(80, num(rec['width'], 480));
  const height = Math.max(40, num(rec['height'], 200));
  const markdown = typeof rec['markdown'] === 'string' ? rec['markdown'] : '';
  const regionName = typeof rec['region'] === 'string' ? rec['region'] : '';

  let parentId: string | null = null;
  if (regionName) {
    const cur = readSnapshot(deps).scene;
    const r = regionsOf(cur.elements).find((e) => e.label === regionName);
    if (!r) {
      fail(res, 404, `未找到区域：${regionName}`);
      return;
    }
    parentId = r.id;
    // x/y 视为区域内相对偏移
    x = r.x + (rec['x'] === undefined ? 20 : x);
    y = r.y + (rec['y'] === undefined ? 60 : y);
  }

  const el = createTextElement({
    x,
    y,
    width,
    height,
    createdBy: actor,
    parentId,
    markdown,
  });

  deps.room.mutate(actor, (scene) => ({
    ...scene,
    elements: [...scene.elements, { ...el, z: nextZ(scene.elements) }],
  }));
  await deps.recordChange(actor);
  // Agent 焦点光标飞到新建元素 —— 标准首行锚点
  pushAgentPresence(deps, actor, el.id, computeEditAnchor(el));
  ok(res, { elementId: el.id });
}

/**
 * POST /api/elements/text-append —— 给 text 元素的 markdown 追加一段内容
 * （流式工作流核心）。直接走 Y.Text.insert(length, chunk) —— 字符级 CRDT，
 * 比整场景 PUT 轻量；不同 Agent / Web 客户端可并发追加，按字符位置合并。
 *
 * 请求体：`{ actor, elementId, chunk, lineIndex? }`
 *  - lineIndex 缺省时按追加后总行数自动算（最末行 - 1）；Agent 知道精确行号
 *    可直接传，浏览器据此把焦点光标钉到对应位置 + jitter。
 */
async function handleTextAppend(
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
  const actor = typeof rec['actor'] === 'string' ? rec['actor'] : 'u_local';
  const elementId =
    typeof rec['elementId'] === 'string' ? rec['elementId'] : '';
  const chunk = typeof rec['chunk'] === 'string' ? rec['chunk'] : '';
  if (!elementId) {
    fail(res, 400, '缺少 elementId');
    return;
  }
  if (chunk === '') {
    // 空 chunk 是 no-op；不推 presence 也不写盘
    ok(res, { ok: true, length: 0 });
    return;
  }

  const doc = deps.room.doc;
  const els = doc.getMap('elements') as Y.Map<Y.Map<unknown>>;
  const elMap = els.get(elementId);
  if (!elMap) {
    fail(res, 404, `元素不存在: ${elementId}`);
    return;
  }
  const elType = elMap.get('type');
  if (elType !== 'text') {
    fail(res, 400, `元素 ${elementId} 不是 text 类型（实际：${String(elType)}）`);
    return;
  }
  const md = elMap.get('markdown');
  if (!(md instanceof Y.Text)) {
    fail(res, 500, `元素 ${elementId} 的 markdown 字段不是 Y.Text`);
    return;
  }
  doc.transact(() => {
    md.insert(md.length, chunk);
    elMap.set('updatedBy', actor);
    elMap.set('updatedAt', new Date().toISOString());
  }, actor);

  // 推 Agent 焦点光标 —— lineIndex 缺省时取追加后总行数 - 1
  const totalLines = md.toString().split('\n').length;
  const explicitLine = typeof rec['lineIndex'] === 'number' ? rec['lineIndex'] : undefined;
  const lineIndex = explicitLine ?? Math.max(0, totalLines - 1);
  const scene = deps.room.getScene();
  const el = scene.elements.find((e) => e.id === elementId);
  if (el) {
    pushAgentPresence(deps, actor, elementId, computeEditAnchor(el, { lineIndex }));
  }

  await deps.recordChange(actor);
  ok(res, { ok: true, length: md.length, lineIndex });
}

/**
 * POST /api/elements/text-set —— 整体替换 text 元素 markdown。
 *
 * 请求体：`{ actor, elementId, markdown }`。
 *
 * 与 text-append 区别：append 是字符级 CRDT 追加（流式打字动画），set 是
 * 整体重置（Agent「改主意了，这版用这个」场景）。**必须走 Y.Text 重置**
 * 而不是 disk 直写 —— 否则 Y.Doc 里 markdown 仍是旧值,下次广播会用 stale
 * 内容覆盖刚写的盘。
 */
async function handleTextSet(
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
  const actor = typeof rec['actor'] === 'string' ? rec['actor'] : 'u_local';
  const elementId =
    typeof rec['elementId'] === 'string' ? rec['elementId'] : '';
  const markdown =
    typeof rec['markdown'] === 'string' ? rec['markdown'] : '';
  if (!elementId) {
    fail(res, 400, '缺少 elementId');
    return;
  }

  const doc = deps.room.doc;
  const els = doc.getMap('elements') as Y.Map<Y.Map<unknown>>;
  const elMap = els.get(elementId);
  if (!elMap) {
    fail(res, 404, `元素不存在: ${elementId}`);
    return;
  }
  const elType = elMap.get('type');
  if (elType !== 'text') {
    fail(res, 400, `元素 ${elementId} 不是 text 类型（实际：${String(elType)}）`);
    return;
  }
  const md = elMap.get('markdown');
  if (!(md instanceof Y.Text)) {
    fail(res, 500, `元素 ${elementId} 的 markdown 字段不是 Y.Text`);
    return;
  }
  doc.transact(() => {
    if (md.length > 0) md.delete(0, md.length);
    if (markdown.length > 0) md.insert(0, markdown);
    elMap.set('updatedBy', actor);
    elMap.set('updatedAt', new Date().toISOString());
  }, actor);

  await deps.recordChange(actor);
  ok(res, { ok: true, length: md.length });
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
/**
 * 推一帧 Agent presence —— Agent 操作时浏览器据此画「围绕目标元素轨道运动」
 * 的光标（PRD §7.4 / §8.2）。
 *
 * Agent 不像人类那样持续上报光标，而是在 server 端某个操作发生时被动注入。
 * clientId 直接复用 participant id（如 `a_travis`），name/color 从
 * meta.participants 取；若 actorId 不在 participants 中（如 `u_local`），跳过。
 */
function pushAgentPresence(
  deps: HttpDeps,
  actorId: string,
  targetElementId: string | null,
  targetOffset?: { x: number; y: number },
): void {
  const p = deps.getMeta().participants.find((x) => x.id === actorId);
  if (!p || p.type !== 'agent') return;
  const entry = deps.presence.update({
    clientId: p.id,
    name: p.name,
    color: p.color,
    cursor: null,
    targetElementId: targetElementId ?? undefined,
    targetOffset,
    isAgent: true,
  });
  const frame = { type: 'presence', client: entry };
  deps.sse.broadcast(frame);
}

/**
 * POST /api/agent-activity —— Agent 工作时报到（PRD §7.4 / §8.2）。
 *
 * 适用场景：sub-agent / 外部 CLI / MCP 工具开始/进行/结束一项工作前后调用。
 * 行为：
 *  1. actorId 不在 meta.participants 中 → 用入参 name/color 自动注册为 agent
 *  2. 推一帧 Agent presence（带可选 cursor + targetElementId），让 web 端看
 *     到 Agent 头像出现 + 光标动画
 *
 * Presence 12s 不报会过期消失；要保持活动状态需周期心跳（建议每 5s 一次）。
 * PresenceBar 同时会从 meta.participants[type=agent] 取曾经参与过的 Agent
 * 持续显示头像（哪怕 presence 已过期）。
 *
 * 请求体: `{ actorId, name?, color?, targetElementId?, cursor?:{x,y} }`
 */
function handleAgentActivity(
  deps: HttpDeps,
  body: unknown,
  res: ServerResponse,
): void {
  if (typeof body !== 'object' || body === null) {
    fail(res, 400, '请求体必须为 JSON 对象');
    return;
  }
  const b = body as Record<string, unknown>;
  const actorId = typeof b['actorId'] === 'string' ? b['actorId'].trim() : '';
  if (!actorId || !actorId.startsWith('a_')) {
    fail(res, 400, 'actorId 必须以 a_ 开头（Agent 命名约定）');
    return;
  }
  const name =
    typeof b['name'] === 'string' && b['name'].trim() ? b['name'].trim() : actorId;
  const color =
    typeof b['color'] === 'string' && b['color'].trim() ? b['color'].trim() : '#1971C2';
  const targetElementId =
    typeof b['targetElementId'] === 'string' && b['targetElementId']
      ? b['targetElementId']
      : null;
  let cursor: { x: number; y: number } | null = null;
  const rawCursor = b['cursor'];
  if (typeof rawCursor === 'object' && rawCursor !== null) {
    const c = rawCursor as Record<string, unknown>;
    if (
      typeof c['x'] === 'number' &&
      typeof c['y'] === 'number' &&
      Number.isFinite(c['x']) &&
      Number.isFinite(c['y'])
    ) {
      cursor = { x: c['x'] as number, y: c['y'] as number };
    }
  }

  // 自动注册 participant（如缺）
  const meta = deps.getMeta();
  const exists = meta.participants.find((p) => p.id === actorId);
  if (!exists) {
    deps.setMeta({
      ...meta,
      participants: [
        ...meta.participants,
        {
          id: actorId,
          type: 'agent',
          name,
          color,
          ownerId: 'u_local',
          avatar: null,
        },
      ],
      updatedAt: new Date().toISOString(),
    });
  } else if (exists.type !== 'agent') {
    fail(res, 409, `${actorId} 已存在于 participants 但 type 不是 agent`);
    return;
  }

  // 推 presence：先 target，再带 cursor 覆盖一帧（pushAgentPresence 默认 cursor=null）
  pushAgentPresence(deps, actorId, targetElementId);
  if (cursor) {
    const p = deps.getMeta().participants.find((x) => x.id === actorId)!;
    const entry = deps.presence.update({
      clientId: p.id,
      name: p.name,
      color: p.color,
      cursor,
      targetElementId: targetElementId ?? undefined,
      isAgent: true,
    });
    const frame = { type: 'presence', client: entry };
    deps.sse.broadcast(frame);
  }

  ok(res, { actorId, registered: !exists });
}

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
  // Agent 专用字段：targetElementId / targetOffset / isAgent
  const targetElementId =
    typeof rec['targetElementId'] === 'string' && rec['targetElementId']
      ? rec['targetElementId']
      : undefined;
  let targetOffset: { x: number; y: number } | undefined;
  const rawOffset = rec['targetOffset'];
  if (typeof rawOffset === 'object' && rawOffset !== null) {
    const o = rawOffset as Record<string, unknown>;
    if (
      typeof o['x'] === 'number' &&
      typeof o['y'] === 'number' &&
      Number.isFinite(o['x']) &&
      Number.isFinite(o['y'])
    ) {
      targetOffset = { x: o['x'], y: o['y'] };
    }
  }
  const isAgent = rec['isAgent'] === true;
  // viewport（PRD §8.2 跟随视角）—— 仅人类用户上报视口左上角的画布坐标 + zoom；
  // 非法 / 缺失即 undefined。
  let viewport: { x: number; y: number; zoom: number } | undefined;
  const rawViewport = rec['viewport'];
  if (typeof rawViewport === 'object' && rawViewport !== null) {
    const v = rawViewport as Record<string, unknown>;
    if (
      typeof v['x'] === 'number' &&
      typeof v['y'] === 'number' &&
      typeof v['zoom'] === 'number' &&
      Number.isFinite(v['x']) &&
      Number.isFinite(v['y']) &&
      Number.isFinite(v['zoom']) &&
      v['zoom'] > 0
    ) {
      viewport = { x: v['x'], y: v['y'], zoom: v['zoom'] };
    }
  }
  const entry = deps.presence.update({
    clientId,
    name,
    color,
    cursor,
    targetElementId,
    targetOffset,
    isAgent,
    viewport,
  });
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

/**
 * GET /api/oplog?tail=<n> —— 取末尾 n 条 oplog（PRD §6.9）。
 *
 * oplog 不是事件流的替代品；事件流是内存环 + SSE 实时推送，oplog 是磁盘
 * append-only 流水，用于审计 / 离线复盘。默认 tail=100，上限 1000。
 */
async function handleOpLog(
  deps: HttpDeps,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const raw = url.searchParams.get('tail');
  const n = raw !== null && Number.isFinite(Number(raw)) ? Number(raw) : 100;
  const cap = Math.min(Math.max(1, n | 0), 1000);
  const entries = await deps.opLog.tail(cap);
  ok(res, { entries, path: deps.opLog.path });
}

// ───────────────────── 快照 / 复原（PRD §8.5）─────────────────────

/** GET /api/snapshots —— 列出当前所有存档点（从 meta 读）。 */
async function handleListSnapshots(
  deps: HttpDeps,
  res: ServerResponse,
): Promise<void> {
  try {
    const list = await listSnapshots(deps.dir);
    ok(res, { snapshots: list });
  } catch (err) {
    fail(res, 500, `读取存档列表失败: ${errMsg(err)}`);
  }
}

/** POST /api/snapshots —— 建一份新存档点（手动；可带名字）。 */
async function handleCreateSnapshot(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: unknown = {};
  try {
    body = await readJsonBody(req);
  } catch {
    /* 允许空请求体 */
  }
  const rec = (body ?? {}) as Record<string, unknown>;
  const name = typeof rec['name'] === 'string' ? rec['name'].trim() : null;
  const actor =
    typeof rec['actor'] === 'string' && rec['actor'] ? rec['actor'] : 'u_local';
  try {
    // 关停 Y.Doc 节流落盘，避免在我们刚 cp 完 board.json 后 server 立刻
    // 把当前内存 Y.Doc 投影回来覆盖 —— 那样快照里的 board.json 就和
    // 当前一致而非「拍下当时」。flushToDisk 强制把 pending 落盘后再 cp。
    await deps.room.flushToDisk();
    const result = await createSnapshot({ dir: deps.dir, name, actor, auto: false });
    deps.setMeta(result.meta);
    deps.emitEvent('snapshot.created', actor, { snapshotId: result.entry.id });
    // 广播 board-changed，让 web 端 refetch /api/board 获取新 meta.snapshots
    await deps.recordChange(actor);
    ok(res, { snapshot: result.entry });
  } catch (err) {
    fail(res, 500, `创建存档失败: ${errMsg(err)}`);
  }
}

/** DELETE /api/snapshots/<id> —— 删除一份存档（含磁盘目录 + meta 索引）。 */
async function handleDeleteSnapshot(
  deps: HttpDeps,
  res: ServerResponse,
  id: string,
  actor: string,
): Promise<void> {
  if (!id) {
    fail(res, 400, '缺少 snapshotId');
    return;
  }
  try {
    const result = await deleteSnapshot({ dir: deps.dir, snapshotId: id });
    if (!result.removed) {
      fail(res, 404, `未找到存档：${id}`);
      return;
    }
    deps.setMeta(result.meta);
    deps.emitEvent('snapshot.created', actor, { snapshotId: id, deleted: true });
    await deps.recordChange(actor);
    ok(res, { removed: id });
  } catch (err) {
    fail(res, 500, `删除存档失败: ${errMsg(err)}`);
  }
}

/**
 * POST /api/snapshots/<id>/restore —— 复原到一个存档点。
 *
 * 流程：flushToDisk → pauseWatcher → restoreSnapshot（自动建 pre 档 +
 * 文件整盘换 + 覆盖 board.json / meta.json）→ room.mutate(scene) →
 * setMeta → resumeWatcher → recordChange + 广播 board-changed。
 */
async function handleRestoreSnapshot(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
): Promise<void> {
  if (!id) {
    fail(res, 400, '缺少 snapshotId');
    return;
  }
  let body: unknown = {};
  try {
    body = await readJsonBody(req);
  } catch {
    /* 空请求体允许 */
  }
  const rec = (body ?? {}) as Record<string, unknown>;
  const actor =
    typeof rec['actor'] === 'string' && rec['actor'] ? rec['actor'] : 'u_local';
  try {
    // 落盘当前 Y.Doc → pre-restore 自动档拍的是「真实当前」
    await deps.room.flushToDisk();
    deps.pauseWatcher();
    let result;
    try {
      result = await restoreSnapshot({
        dir: deps.dir,
        snapshotId: id,
        actor,
      });
    } finally {
      // 即便 restoreSnapshot 抛错，也要恢复 watcher（保 server 健康）
      try {
        deps.resumeWatcher(deps.getFiles());
      } catch {
        /* ignore */
      }
    }
    // 把新场景写进 Y.Doc —— applySceneDiff 算出最小 op 集广播给所有 ws
    deps.room.mutate(actor, () => result.scene);
    deps.setMeta(result.meta);
    // 对齐 watcher 的内存文件集合（restoreSnapshot 已整盘换 files/）
    deps.resumeWatcher(result.files);
    await deps.recordChange(actor);
    deps.emitEvent('snapshot.restored', actor, {
      snapshotId: id,
      preRestoreSnapshotId: result.preRestoreSnapshotId,
    });
    ok(res, {
      restored: id,
      preRestoreSnapshotId: result.preRestoreSnapshotId,
    });
  } catch (err) {
    fail(res, 500, `复原失败: ${errMsg(err)}`);
  }
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
 * 解析请求里的 boardId → 对应 HttpDeps；返回 null 表示未找到。
 *
 * 实参由 server/index.ts 注入 —— 持有 `Map<boardId, BoardRuntime>`。
 * `boardId === null` 表示请求未带 `/api/boards/<id>` 前缀，应取默认 board。
 */
export type DepsResolver = (boardId: string | null) => HttpDeps | null;

/**
 * 鉴权回调 —— 给定 deps 和 URL，返回是否允许；返 false 时 server 回 401。
 *
 * 由 index.ts 注入，根据 `BOARD_REQUIRE_TOKEN` 环境变量决定策略：
 *  - 未开（默认）：始终返 true（本地 dev / 单 board 顺手）
 *  - 开了：必须 `?token=<shareToken>` 或 `Authorization: Bearer <shareToken>`，
 *    与 board 的 meta.shareToken 严格相等才放行
 */
export type AuthChecker = (deps: HttpDeps, url: URL, req: IncomingMessage) => boolean;

/**
 * BoardsManager 注入参数 —— http.ts 用它处理 `/api/boards`（不带 boardId）
 * 与 `DELETE /api/boards/<id>` 这类"管理 server 下的 board 集合"的端点。
 * 见 boards-manager.ts。
 */
export interface BoardsManagerForHttp {
  list(): Array<{
    id: string;
    name: string;
    dir: string;
    createdAt: string;
    updatedAt: string;
    isDefault: boolean;
  }>;
  create(input: { name: string }): Promise<{
    id: string;
    name: string;
    dir: string;
    createdAt: string;
    updatedAt: string;
    isDefault: boolean;
  }>;
  delete(id: string): Promise<void>;
}

/**
 * 创建 HTTP server（未 listen）。host 固定 127.0.0.1。
 *
 * 多 board 路由：路径 `/api/boards/<id>/<rest>` 剥前缀后由 `getDeps(id)`
 * 解析；无前缀的 `/api/<rest>` 由 `getDeps(null)` 解析（默认 board，
 * 用于单 board 部署与既有客户端的向后兼容）。
 *
 * 管理端点（PRD §4.2 多 board 中继）：
 *  - `GET  /api/boards`        列出 server 当前托管的所有 board
 *  - `POST /api/boards`        新建一个空白 board（body: {name}）
 *  - `DELETE /api/boards/<id>` 关 runtime + 移 .board 到 _trash/
 *
 * 管理端点在 BOARD_REQUIRE_TOKEN=true 部署下返 403 —— 公网中继不应让任意
 * 用户增删 board；admin 在 server 主机上用 CLI 操作。
 */
export function createHttpServer(
  getDeps: DepsResolver,
  checkAuth?: AuthChecker,
  boardsManager?: BoardsManagerForHttp,
): Server {
  const server = createServer((req, res) => {
    // 顶层 try：URL 解析 / decodeURIComponent 在非法序列上会抛同步错误，
    // 不能让单次坏请求崩掉整个进程。任何异常都转成 400，不让冒到 server.
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${HOST}`);
    } catch (err) {
      fail(res, 400, `非法请求 URL: ${errMsg(err)}`);
      return;
    }
    const rawPath = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';

    // ── 管理端点（不走 getDeps / checkAuth；它们由 boardsManager 自己处理）──
    // GET /api/boards —— 列表
    if (rawPath === '/api/boards' && method === 'GET') {
      if (!boardsManager) {
        fail(res, 404, '该 server 未启用 boards 管理端点');
        return;
      }
      if (checkAuth) {
        fail(res, 403, '公网部署下管理端点禁用，请在 server 主机上用 CLI');
        return;
      }
      const list = boardsManager.list();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ boards: list }));
      return;
    }
    // POST /api/boards —— 新建
    if (rawPath === '/api/boards' && method === 'POST') {
      if (!boardsManager) {
        fail(res, 404, '该 server 未启用 boards 管理端点');
        return;
      }
      if (checkAuth) {
        fail(res, 403, '公网部署下管理端点禁用，请在 server 主机上用 CLI');
        return;
      }
      void (async () => {
        try {
          const body = (await readJsonBody(req)) as { name?: unknown };
          if (typeof body.name !== 'string') {
            fail(res, 400, 'body.name 必填且为字符串');
            return;
          }
          const summary = await boardsManager.create({ name: body.name });
          res.writeHead(201, {
            'content-type': 'application/json; charset=utf-8',
          });
          res.end(JSON.stringify(summary));
        } catch (err) {
          const msg = errMsg(err);
          // 已存在 → 409，其它视为 400（输入校验）
          if (/已存在|冲突/.test(msg)) {
            fail(res, 409, msg);
          } else {
            fail(res, 400, msg);
          }
        }
      })();
      return;
    }
    // DELETE /api/boards/<id> —— 删除（无后续路径段）
    const mDel = /^\/api\/boards\/([^/]+)$/.exec(rawPath);
    if (mDel && method === 'DELETE') {
      if (!boardsManager) {
        fail(res, 404, '该 server 未启用 boards 管理端点');
        return;
      }
      if (checkAuth) {
        fail(res, 403, '公网部署下管理端点禁用，请在 server 主机上用 CLI');
        return;
      }
      let delId: string;
      try {
        delId = decodeURIComponent(mDel[1]!);
      } catch (err) {
        fail(res, 400, `非法 boardId 编码: ${errMsg(err)}`);
        return;
      }
      void (async () => {
        try {
          await boardsManager.delete(delId);
          res.writeHead(204);
          res.end();
        } catch (err) {
          const msg = errMsg(err);
          if (/不存在/.test(msg)) {
            fail(res, 404, msg);
          } else if (/保留|最后一个/.test(msg)) {
            fail(res, 409, msg);
          } else {
            fail(res, 400, msg);
          }
        }
      })();
      return;
    }

    // ── 单 board 路由（既有）──
    let boardId: string | null = null;
    // 形如 /api/boards/<id> 或 /api/boards/<id>/<rest>
    const m = /^\/api\/boards\/([^/]+)(\/.*)?$/.exec(rawPath);
    if (m) {
      try {
        boardId = decodeURIComponent(m[1]!);
      } catch (err) {
        fail(res, 400, `非法 boardId 编码: ${errMsg(err)}`);
        return;
      }
      // 把 req.url 重写为剥前缀后的形式，下游 route() 沿用既有匹配
      const rest = m[2] ?? '';
      const newPath = '/api' + rest;
      const search = url.search ?? '';
      req.url = newPath + search;
    }
    const deps = getDeps(boardId);
    if (!deps) {
      fail(res, 404, `未找到白板: ${boardId ?? '(默认)'}`);
      return;
    }
    // 鉴权 —— BOARD_REQUIRE_TOKEN=true 部署时强制；本地 dev 默认放行。
    // /api/health 例外：开放探活给反向代理 / 部署脚本用。
    if (checkAuth && url.pathname !== '/api/health' && !checkAuth(deps, url, req)) {
      fail(res, 401, '需要有效的 token —— 用 ?token=<shareToken> 或 Authorization: Bearer <shareToken>');
      return;
    }
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
  // 套接字层异常（含 ws upgrade 路径中 decodeURIComponent 抛错）也兜底，
  // 不能透传到 process 的 uncaughtException 导致进程崩。
  server.on('clientError', (err, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    } catch {
      // socket 已断开，忽略
    }
    console.error('[board-server] 客户端请求错误:', err.message);
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
    handleGetBoard(deps, res);
    return;
  }
  if (path === '/api/board' && method === 'PUT') {
    await handlePutBoard(deps, req, res);
    return;
  }
  // POST /api/ops 已删除（M4 增量3）—— 改走 ws /yjs Y.Doc 协议
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
  // POST /api/agent-activity —— Agent 工作时报到（CLI / sub-agent 用）
  // 体: { actorId, name?, color?, targetElementId?, cursor?:{x,y} }
  // 行为: 缺 participant 时自动注册 + 推一帧 Agent presence（带可选光标）
  if (path === '/api/agent-activity' && method === 'POST') {
    let aaBody: unknown;
    try {
      aaBody = await readJsonBody(req);
    } catch (err) {
      fail(res, 400, errMsg(err));
      return;
    }
    handleAgentActivity(deps, aaBody, res);
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
  // GET /api/oplog —— PRD §6.9 操作日志（磁盘 append-only）
  if (path === '/api/oplog' && method === 'GET') {
    await handleOpLog(deps, res, url);
    return;
  }
  // POST /api/files/move —— 文件移动；须先于 /api/files/ 文件读取分支判断
  if (path === '/api/files/move' && method === 'POST') {
    await handleMoveFile(deps, req, res);
    return;
  }
  // POST /api/files/upload?path=<相对路径> —— 上传任意文件到 files/
  if (path === '/api/files/upload' && method === 'POST') {
    await handleFileUpload(deps, req, res, url);
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
  // 快照 / 复原（PRD §8.5）—— ls / create / restore / delete
  if (path === '/api/snapshots' && method === 'GET') {
    await handleListSnapshots(deps, res);
    return;
  }
  if (path === '/api/snapshots' && method === 'POST') {
    await handleCreateSnapshot(deps, req, res);
    return;
  }
  // POST /api/snapshots/<id>/restore
  if (
    path.startsWith('/api/snapshots/') &&
    path.endsWith('/restore') &&
    method === 'POST'
  ) {
    const id = path.slice('/api/snapshots/'.length, -'/restore'.length);
    await handleRestoreSnapshot(deps, req, res, id);
    return;
  }
  if (path.startsWith('/api/snapshots/') && method === 'DELETE') {
    const id = path.slice('/api/snapshots/'.length);
    // actor 由 query 或 default
    const actorQ = url.searchParams.get('actor');
    await handleDeleteSnapshot(deps, res, id, actorQ ?? 'u_local');
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
  // POST /api/elements/text-create —— 创建空 text 元素（流式工作流起手）
  if (path === '/api/elements/text-create' && method === 'POST') {
    await handleTextCreate(deps, req, res);
    return;
  }
  // POST /api/elements/text-append —— 给 text 元素流式追加 markdown（Y.Text.insert）
  if (path === '/api/elements/text-append' && method === 'POST') {
    await handleTextAppend(deps, req, res);
    return;
  }
  // POST /api/elements/text-set —— 整体替换 text 元素 markdown（Y.Text reset）
  if (path === '/api/elements/text-set' && method === 'POST') {
    await handleTextSet(deps, req, res);
    return;
  }
  // POST /api/regions/reparent —— 区域移入 / 移出区域（子区域嵌套）
  if (path === '/api/regions/reparent' && method === 'POST') {
    await handleReparentRegion(deps, req, res);
    return;
  }
  // POST /api/regions —— 在画布上创建区域（建文件夹 + region 元素）
  if (path === '/api/regions' && method === 'POST') {
    await handleCreateRegion(deps, req, res);
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
