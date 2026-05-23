/**
 * 当前会话连到哪个 board —— 多 board 中继模式（PRD §4.2）。
 *
 * 从 URL query 取：
 *  - `?board=trip` → activeBoardId() = 'trip'；缺失则走 server 默认 board
 *  - `?token=<shareToken>` → 鉴权 token；server 开启 `BOARD_REQUIRE_TOKEN=true`
 *    时必填。本地 dev 不强制 token，缺省即可。
 *
 * 启动期一次性读取，整个 tab 生命周期内不变（URL 改了要刷新页面才切换）。
 */

/** 一次性读 URL query 的字符串值；为空 / 缺失 / 非浏览器环境返回 null。 */
function readQueryOnce(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = new URLSearchParams(window.location.search).get(key);
    if (!v) return null;
    const trimmed = v.trim();
    return trimmed === '' ? null : trimmed;
  } catch {
    return null;
  }
}

const ACTIVE_BOARD_ID: string | null = readQueryOnce('board');
const ACTIVE_TOKEN: string | null = readQueryOnce('token');

/** 当前 tab 连到的 boardId，null 表示走 server 的默认 board。 */
export function activeBoardId(): string | null {
  return ACTIVE_BOARD_ID;
}

/** 当前 tab 的鉴权 token；null 表示未带。 */
export function activeToken(): string | null {
  return ACTIVE_TOKEN;
}

/**
 * 拼接 HTTP API URL —— 带 boardId 时走 `/api/boards/<id>/<sub>`，
 * 否则走 `/api/<sub>`（默认 board）。token 若存在则自动追加 `?token=` 查询。
 *
 * @param sub `/board`、`/regions`、`/snapshots/xxx` 等子路径（前导 `/` 可有可无）。
 */
export function apiUrl(sub: string): string {
  const safe = sub.startsWith('/') ? sub : '/' + sub;
  const base =
    ACTIVE_BOARD_ID === null
      ? '/api' + safe
      : '/api/boards/' + encodeURIComponent(ACTIVE_BOARD_ID) + safe;
  if (ACTIVE_TOKEN === null) return base;
  const sep = base.includes('?') ? '&' : '?';
  return base + sep + 'token=' + encodeURIComponent(ACTIVE_TOKEN);
}

/**
 * Yjs ws URL —— 路径 `/yjs[/<boardId>]`。
 *
 * 生产 / 反向代理：走同源 `loc.host`，路径透传到 server。
 * dev：vite 5.x 的 ws proxy 偶发 ECONNABORTED 导致 yjs sync 失败 ——
 *   默认直连 board-server 端口（4500），bypass vite ws proxy。
 *   通过 VITE_BOARD_WS_PORT 环境变量覆盖端口（如多 board server 调试）。
 *
 * token 若存在则自动追加 `?token=` 查询。
 */
export function yjsWsUrl(): string {
  const loc = window.location;
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  // vite 注入的 import.meta.env.DEV 在 dev 模式为 true、prod 为 false
  // VITE_BOARD_WS_PORT 是显式 dev 端口 override（启动 vite 时设环境变量）
  const env = (import.meta as ImportMeta & { env?: Record<string, string> }).env;
  const devPortOverride = env?.['VITE_BOARD_WS_PORT'];
  const isDev = !!env?.['DEV'];
  let base: string;
  if (devPortOverride) {
    base = `${proto}//${loc.hostname}:${devPortOverride}/yjs`;
  } else if (isDev) {
    base = `${proto}//${loc.hostname}:4500/yjs`;
  } else {
    base = `${proto}//${loc.host}/yjs`;
  }
  const path =
    ACTIVE_BOARD_ID === null
      ? base
      : base + '/' + encodeURIComponent(ACTIVE_BOARD_ID);
  return ACTIVE_TOKEN === null
    ? path
    : path + '?token=' + encodeURIComponent(ACTIVE_TOKEN);
}
