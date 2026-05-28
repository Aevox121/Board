/**
 * server 多白板 API 前缀 helper —— `cmd*` 与 server-direct 端点通信时,
 * 根据当前白板 id 拼路径前缀。
 *
 * 用法:`fetch(`${apiPrefix(args)}/elements/text-create`, ...)`
 *  - args 含 `--board-id <id>` 时 → `/api/boards/<id>/elements/text-create`(多白板)
 *  - 无 → `/api/elements/text-create`(单白板 / 默认 board 回退)
 *
 * 谁注入 board-id:
 *  - MCP 模式:工具 handler 在 mkArgs 里塞 `'board-id': deriveBoardId(boardPath)`,
 *    server 跑多白板时正确路由,跑单白板时回退默认 board 也能命中。
 *  - 普通 CLI:用户显式带 `--board-id`(可选);不带就用默认 board。
 */
import type { ParsedArgs } from './args.js';

/** 拿当前 args 的 board-id,有就返回多 board 路径前缀,没有就返回 `/api`。 */
export function apiPrefix(args: ParsedArgs): string {
  const id = args.options.get('board-id');
  if (id !== undefined && id !== '') {
    return `/api/boards/${encodeURIComponent(id)}`;
  }
  return '/api';
}
