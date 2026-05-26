/**
 * `board comment <白板路径> <目标元素id> "<文本>"` — 给元素加一条评论（PRD §8.4）。
 *
 * 评论存于元素的 `comments` 字段；评论者身份取 `--actor` / `--agent`。
 */
import type { ElementComment, Element } from '@board/core';
import type { ParsedArgs } from '../util/args.js';
import { CliError, EXIT, type CmdResult } from '../util/io.js';
import { resolveBoardDir } from '../util/board.js';
import { openBoard } from '../util/board-io.js';

/** 无 `--actor` / `--agent` 时的默认参与者 id。 */
const DEFAULT_ACTOR = 'u_local';

/** 执行 comment 命令。 */
export async function cmdComment(args: ParsedArgs): Promise<CmdResult> {
  const boardPath = args.positionals[0];
  const elementId = args.positionals[1];
  const text = args.positionals[2];
  if (boardPath === undefined || elementId === undefined || text === undefined) {
    throw new CliError(
      '用法: board comment <白板路径> <目标元素id> "<文本>"',
      EXIT.USAGE,
    );
  }
  if (text.trim() === '') {
    throw new CliError('评论内容不能为空。', EXIT.USAGE);
  }

  const dir = resolveBoardDir(boardPath, args.options.get('board'));
  const handle = await openBoard(dir);
  const target = handle.scene.elements.find((e) => e.id === elementId);
  if (!target) {
    throw new CliError(`未找到元素：${elementId}`, EXIT.NOT_FOUND);
  }

  const actor =
    args.options.get('actor') ?? args.options.get('agent') ?? DEFAULT_ACTOR;
  const comment: ElementComment = {
    by: actor,
    text: text.trim(),
    ts: new Date().toISOString(),
  };
  const total = (target.comments?.length ?? 0) + 1;
  const next = handle.scene.elements.map((e): Element =>
    e.id === elementId
      ? {
          ...e,
          comments: [...(e.comments ?? []), comment],
          updatedBy: actor,
          updatedAt: comment.ts,
        }
      : e,
  );
  await handle.save({ ...handle.scene, elements: next });

  return {
    code: EXIT.OK,
    text: `已给元素 ${elementId} 添加评论（共 ${total} 条）`,
    data: { elementId, by: actor, commentCount: total },
  };
}
