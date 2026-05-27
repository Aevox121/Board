/**
 * `board mv <白板路径> <源相对路径> <目标相对路径>` — 移动 files/ 内的文件。
 *
 * 规格 §2.2:把 `files/` 下的一个文件改名 / 移动到新的相对路径。这是「画布 →
 * 文件系统」方向的命令行入口,与 Web 端拖拽文件卡改归属等价 —— Agent 默认经
 * CLI 操作白板。
 *
 * 实现:走 server 的 POST /api/files/move(server 端 fs rename + scene 同步)。
 * 不在 CLI 本机 fs 上直接 rename。
 */
import { normalizePath } from '@board/core';
import type { ParsedArgs } from '../util/args.js';
import { CliError, EXIT, type CmdResult } from '../util/io.js';
import { resolveBoardDir } from '../util/board.js';
import { openBoard } from '../util/board-io.js';
import { resolveActor, buildAgentActivity } from '../util/actor.js';

/** 校验相对路径不含 `..` 段。 */
function assertNoDotDot(rel: string, label: string): void {
  if (rel.split('/').includes('..')) {
    throw new CliError(`${label}不能包含 ".."：${rel}`, EXIT.USAGE);
  }
}

/** 执行 mv 命令。 */
export async function cmdMv(args: ParsedArgs): Promise<CmdResult> {
  const usage = 'board mv <白板路径> <源相对路径> <目标相对路径>';
  const boardPath = args.positionals[0];
  const srcRel = args.positionals[1];
  const destRel = args.positionals[2];
  if (boardPath === undefined) {
    throw new CliError(`缺少白板路径。用法: ${usage}`, EXIT.USAGE);
  }
  if (srcRel === undefined) {
    throw new CliError(`缺少源相对路径。用法: ${usage}`, EXIT.USAGE);
  }
  if (destRel === undefined) {
    throw new CliError(`缺少目标相对路径。用法: ${usage}`, EXIT.USAGE);
  }

  const from = normalizePath(srcRel);
  const to = normalizePath(destRel);
  if (!from) {
    throw new CliError('源相对路径不能为空。', EXIT.USAGE);
  }
  if (!to) {
    throw new CliError('目标相对路径不能为空。', EXIT.USAGE);
  }
  if (from === to) {
    throw new CliError('源路径与目标路径相同。', EXIT.USAGE);
  }
  assertNoDotDot(from, '源相对路径');
  assertNoDotDot(to, '目标相对路径');

  const dir = resolveBoardDir(boardPath, args.options.get('board'));
  const handle = await openBoard(dir);
  const actor = resolveActor(args);

  await handle.server.moveFile(from, to, { actor });

  // server 移完同步 scene,本地拉一遍知道哪个元素被搬了 → presence 锚点
  const { scene: nextScene } = await handle.server.fetchBoard();
  const movedEl = nextScene.elements.find(
    (e) => e.type === 'file' && e.path === to,
  );
  await handle.announceAgent(buildAgentActivity(args, actor, movedEl?.id));

  return {
    code: EXIT.OK,
    text: `已移动 files/${from} → files/${to}`,
    data: { from, to, elementId: movedEl?.id ?? null },
  };
}
