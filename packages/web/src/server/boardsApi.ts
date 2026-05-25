/**
 * 多 board 管理 API 客户端（PRD §4.2 多 board 中继）。
 *
 * 与 boardSession.ts 的 `apiUrl(...)` 不同：管理端点**不在某个 board 下**，
 * 直接打 `/api/boards`、`DELETE /api/boards/<id>`，不带 boardId 前缀。
 *
 * server 在 BOARD_REQUIRE_TOKEN=true 下会对管理端点返 403 —— `listBoards`
 * 静默吞掉返空数组，UI 端据此隐藏 BoardSwitcher 入口；写操作（create /
 * delete）让错误冒上来，由调用方 toast。
 */

export interface BoardSummary {
  id: string;
  name: string;
  dir: string;
  createdAt: string;
  updatedAt: string;
  isDefault: boolean;
}

/** 列出 server 当前托管的所有 board；403/404/网络异常 → 返空数组（管理端点被禁用）。 */
export async function listBoards(): Promise<BoardSummary[]> {
  try {
    const res = await fetch('/api/boards', { method: 'GET' });
    if (!res.ok) return [];
    const j = (await res.json()) as { boards?: BoardSummary[] };
    return Array.isArray(j.boards) ? j.boards : [];
  } catch {
    return [];
  }
}

/** 新建一个空白 board；server 已存在同名 / 校验失败时抛错。 */
export async function createBoard(name: string): Promise<BoardSummary> {
  const res = await fetch('/api/boards', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `创建失败 HTTP ${res.status}`);
  }
  return (await res.json()) as BoardSummary;
}

/** 删除一个 board（server 会把 .board 移到 _trash/，不真删）。 */
export async function deleteBoard(id: string): Promise<void> {
  const res = await fetch('/api/boards/' + encodeURIComponent(id), {
    method: 'DELETE',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `删除失败 HTTP ${res.status}`);
  }
}

/**
 * 切换到目标 board —— 修改 URL `?board=<id>` 并整页 reload。
 *
 * Why reload: boardSession.ts 在模块加载时一次性读 URL query，整个 tab 生
 * 命周期内不变；Y.Doc / ws / chokidar SSE 全在 BoardContext 启动时绑定的
 * boardId 上，切换 board 需要全栈重建。reload 是最干净的实现，代价仅是
 * 几百 ms 的页面刷新，远低于尝试热切换的复杂度。
 */
export function switchToBoard(id: string | null): void {
  const url = new URL(window.location.href);
  if (id === null) {
    url.searchParams.delete('board');
  } else {
    url.searchParams.set('board', id);
  }
  window.location.href = url.toString();
}
