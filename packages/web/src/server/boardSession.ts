/**
 * 当前会话连到哪个 board —— 多 board 中继模式（PRD §4.2）。
 *
 * boardId 从 URL query 取：`?board=trip` → activeBoardId() = 'trip'。
 * 未带 query 参数 → null，走 server 的默认 board（单 board 部署的向后兼容）。
 *
 * 启动期一次性读取，整个 tab 生命周期内不变（URL 改了要刷新页面才切换）。
 */

/** 从 `window.location.search` 解析 boardId；非法 / 缺失返回 null。 */
function readBoardIdOnce(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const v = params.get('board');
    if (!v) return null;
    const trimmed = v.trim();
    return trimmed === '' ? null : trimmed;
  } catch {
    return null;
  }
}

const ACTIVE_BOARD_ID: string | null =
  typeof window !== 'undefined' ? readBoardIdOnce() : null;

/** 当前 tab 连到的 boardId，null 表示走 server 的默认 board。 */
export function activeBoardId(): string | null {
  return ACTIVE_BOARD_ID;
}

/**
 * 拼接 HTTP API URL —— 带 boardId 时走 `/api/boards/<id>/<sub>`，
 * 否则走 `/api/<sub>`（默认 board）。
 *
 * @param sub `/board`、`/regions`、`/snapshots/xxx` 等子路径（前导 `/` 可有可无）。
 */
export function apiUrl(sub: string): string {
  const safe = sub.startsWith('/') ? sub : '/' + sub;
  if (ACTIVE_BOARD_ID === null) return '/api' + safe;
  return '/api/boards/' + encodeURIComponent(ACTIVE_BOARD_ID) + safe;
}

/**
 * Yjs ws URL —— 与当前页同源（同 host:port），路径 `/yjs[/<boardId>]`。
 *
 * dev 模式下 vite (4510) 转发 `/yjs` ws 到 board-server (4500)；生产同源
 * 部署或反向代理时也透明工作。分享链接可直接复制 URL 给协作者，无需
 * 关心端口暴露细节。
 */
export function yjsWsUrl(): string {
  const loc = window.location;
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = `${proto}//${loc.host}/yjs`;
  return ACTIVE_BOARD_ID === null
    ? base
    : base + '/' + encodeURIComponent(ACTIVE_BOARD_ID);
}
