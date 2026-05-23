/**
 * board-server 文件内容客户端 —— 取 `files/` 下单个文件的真实内容（M2）。
 *
 * server 在 `GET /api/files/<相对路径>` 暴露文件原始字节（dev 经 Vite proxy
 * 转发，见 vite.config.ts）。本模块只用浏览器内置 `fetch`，不引入额外依赖。
 *
 * 用途：
 *  - `fileContentUrl()` —— 给图片预览的 `<img src>` 用（浏览器直接拉取）。
 *  - `fetchFileText()`  —— 取文本/Markdown 文件内容做就地预览。
 *
 * 离线模式或 server 未实现该端点时，调用方应优雅降级（图片显示占位、
 * Markdown 卡退化为索引卡片），不报错、不崩溃。
 */

import { apiUrl } from './boardSession';

/** 取文件内容请求的超时（毫秒）—— 预览类请求，失败即降级。 */
const FILE_REQUEST_TIMEOUT_MS = 8000;

/**
 * 把 `files/` 相对路径编码为可直接放进 `<img src>` 的 URL。
 *
 * 路径按 `/` 切段后逐段 `encodeURIComponent`，避免中文/空格/特殊字符破坏 URL，
 * 同时保留目录分隔符 `/`。
 *
 * @param relPath 相对 `files/` 的路径（如 `路线/day1-route.md`）
 */
export function fileContentUrl(relPath: string): string {
  const encoded = relPath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return apiUrl(`/files/${encoded}`);
}

/**
 * 取一个文本文件的内容（用于 Markdown / 纯文本就地预览）。
 *
 * @param relPath 相对 `files/` 的路径
 * @returns 文件文本内容；server 不可达 / 端点未实现 / 非 2xx 时返回 `null`
 *          （调用方据此降级，不抛错）。
 */
export async function fetchFileText(relPath: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FILE_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(fileContentUrl(relPath), {
      method: 'GET',
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    // server 未启动 / 网络中断 / 超时 / 端点未实现 —— 一律降级为 null。
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** POST /api/files/move 的响应信封形状 —— 与 server Envelope 对应。 */
interface MoveEnvelope {
  ok?: boolean;
  error?: string | null;
}

/**
 * 请求 server 把 `files/` 下的一个文件移动到新的相对路径（画布 → 文件系统）。
 *
 * 用于 Web 端拖动文件卡跨区域：server 重命名真实文件后经 SSE 广播
 * `board-changed`，Web 据此刷新画布。
 *
 * 传入落点 `x,y` 时，server 会把文件卡定位到该落点并**保留位置（不自动排布）**；
 * 不传则由 server 自动排布。
 *
 * @param from 源相对路径（相对 `files/`）
 * @param to   目标相对路径（相对 `files/`）
 * @param x    可选，文件卡落点的画布 X 坐标
 * @param y    可选，文件卡落点的画布 Y 坐标
 * @throws Error 网络不可达、超时、或 server 拒绝移动（错误信息可读，供 UI 提示）。
 */
export async function moveFile(
  from: string,
  to: string,
  x?: number,
  y?: number,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FILE_REQUEST_TIMEOUT_MS);
  const payload: Record<string, unknown> = { from, to };
  if (typeof x === 'number' && typeof y === 'number') {
    payload.x = x;
    payload.y = y;
  }
  let res: Response;
  try {
    res = await fetch(apiUrl('/files/move'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('移动文件请求超时');
    }
    throw new Error('无法连接 board-server');
  }
  clearTimeout(timer);

  let body: MoveEnvelope;
  try {
    body = (await res.json()) as MoveEnvelope;
  } catch {
    body = {};
  }
  if (!res.ok || !body.ok) {
    throw new Error(body.error ?? `移动文件失败（HTTP ${res.status}）`);
  }
}
