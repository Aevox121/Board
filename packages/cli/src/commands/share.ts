/**
 * `board share <路径>` —— 生成可分享的白板链接（M4 工作包3 中继服务器）。
 *
 * 输出形如 `http://<host>:<port>/?board=<boardId>&token=<shareToken>` 的 URL，
 * 供协作者粘贴打开。链接对应的 board-server 必须以多 board 模式启动并把该
 * 白板加入加载列表。
 *
 * boardId 由 .board 目录的 basename 派生（与 server/index.ts:deriveBoardId 一致）：
 * 去掉 `.board` 后缀 + URL 编码。
 *
 * 选项：
 *  - `--host <host>`   分享 URL 的 host（默认 `BOARD_SHARE_HOST` 环境变量；
 *                      没有则用 `localhost`）
 *  - `--port <port>`   分享 URL 的端口（默认 `BOARD_SHARE_PORT` 或 `4510`）
 *  - `--scheme <s>`    `http` / `https`（默认 http）
 *  - `--no-token`      不在 URL 中拼 token（用于 `BOARD_REQUIRE_TOKEN=false` 部署）
 *
 * 注意：CLI 不主动启动 server；只组装 URL。是否可达由用户保证。
 */
import { basename } from 'node:path';
import { loadBoard } from '@board/core/node';
import type { ParsedArgs } from '../util/args.js';
import { CliError, EXIT, type CmdResult } from '../util/io.js';
import { resolveBoardDir } from '../util/board.js';

/** 从 .board 目录派生 URL 用的 boardId（与 server/index.ts:deriveBoardId 一致）。 */
function deriveBoardId(dir: string): string {
  const base = basename(dir).replace(/\.board$/i, '');
  return base || 'board';
}

export async function cmdShare(args: ParsedArgs): Promise<CmdResult> {
  const boardPath = args.positionals[0];
  if (boardPath === undefined) {
    throw new CliError(
      '用法: board share <白板路径> [--host <host>] [--port <port>] [--scheme http|https] [--no-token]',
      EXIT.USAGE,
    );
  }

  const dir = resolveBoardDir(boardPath, args.options.get('board'));
  const handle = await loadBoard(dir); // 校验白板可读

  const boardId = deriveBoardId(dir);
  const host =
    args.options.get('host') ?? process.env['BOARD_SHARE_HOST'] ?? 'localhost';
  const port =
    args.options.get('port') ?? process.env['BOARD_SHARE_PORT'] ?? '4510';
  const scheme = args.options.get('scheme') ?? 'http';
  if (scheme !== 'http' && scheme !== 'https') {
    throw new CliError(`--scheme 必须是 http 或 https：${scheme}`, EXIT.USAGE);
  }

  const portFragment = port === '' || port === '80' || port === '443' ? '' : `:${port}`;
  const includeToken = !args.flags.has('no-token') && Boolean(handle.meta.shareToken);
  const tokenFragment = includeToken
    ? `&token=${encodeURIComponent(handle.meta.shareToken!)}`
    : '';
  const url = `${scheme}://${host}${portFragment}/?board=${encodeURIComponent(boardId)}${tokenFragment}`;

  const lines = [
    `白板:    ${handle.meta.name}`,
    `boardId: ${boardId}`,
    `链接:    ${url}`,
  ];
  if (includeToken) {
    lines.push(`token:   ${handle.meta.shareToken}`);
    lines.push('');
    lines.push('该 token 是白板的访问凭证 —— 谁有 URL 谁就能编辑。请谨慎分发。');
  } else if (handle.meta.shareToken && args.flags.has('no-token')) {
    lines.push('');
    lines.push('已按 --no-token 移除 URL 中的 token；仅用于关闭鉴权的部署。');
  }
  lines.push('');
  lines.push('使用前请确保 board-server 以多 board 模式启动并加载了该白板：');
  lines.push(`  board-server ${dir}`);
  lines.push('要在公网中继，设 BOARD_HOST=0.0.0.0 + BOARD_REQUIRE_TOKEN=true，');
  lines.push('再通过反向代理把 / · /api · /yjs 转到同一台 board-server。');

  return {
    code: EXIT.OK,
    text: lines.join('\n'),
    data: {
      name: handle.meta.name,
      boardId,
      url,
      scheme,
      host,
      port: portFragment === '' ? null : Number(port),
      token: includeToken ? handle.meta.shareToken : null,
    },
  };
}
