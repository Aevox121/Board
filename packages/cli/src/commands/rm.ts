/**
 * `board rm <白板路径> <元素id>` — 删除元素。
 *
 * 规格 §2.2:删除元素。`file` 元素的真实文件移入回收站 `.runtime/trash/`
 * (可恢复,导出时随 .runtime 一并剔除)。同时清理引用该元素的连线与建议,
 * 避免悬空。`region` 元素级联删除其内文件/子区域 + 文件夹移入回收站(server
 * 端处理,可恢复);`folder` 元素背后是真实文件夹,不在本命令删除范围
 * (请直接操作文件夹)。按区域名删更顺手:`board region rm <名>`。
 *
 * 实现:走 server 的 POST /api/elements/delete(server 端处理 trash 移动 +
 * 引用清理 + scene 同步)。CLI 不在本机 fs 上直接 rename。
 */
import type { ParsedArgs } from '../util/args.js';
import { CliError, EXIT, type CmdResult } from '../util/io.js';
import { resolveBoardDir } from '../util/board.js';
import { openBoard } from '../util/board-io.js';
import { resolveActor, buildAgentActivity } from '../util/actor.js';

/** 执行 rm 命令。 */
export async function cmdRm(args: ParsedArgs): Promise<CmdResult> {
  const boardPath = args.positionals[0];
  const elementId = args.positionals[1];
  if (boardPath === undefined) {
    throw new CliError('缺少白板路径。用法: board rm <白板路径> <元素id>', EXIT.USAGE);
  }
  if (elementId === undefined) {
    throw new CliError('缺少元素 id。用法: board rm <白板路径> <元素id>', EXIT.USAGE);
  }

  const dir = resolveBoardDir(boardPath, args.options.get('board'));
  const handle = await openBoard(dir);
  const target = handle.scene.elements.find((e) => e.id === elementId);
  if (!target) {
    throw new CliError(`未找到元素：${elementId}`, EXIT.NOT_FOUND);
  }
  if (target.type === 'folder') {
    throw new CliError(
      `不支持用 rm 删除 folder 元素(其背后是真实文件夹,请直接操作文件夹)。`,
      EXIT.USAGE,
    );
  }

  const actor = resolveActor(args);
  await handle.server.deleteElement(elementId, actor);
  await handle.announceAgent(buildAgentActivity(args, actor));

  const note =
    target.type === 'file'
      ? ',文件移入回收站'
      : target.type === 'region'
        ? ',区域及其内容(文件夹)移入回收站'
        : '';
  return {
    code: EXIT.OK,
    text: `已删除元素 ${elementId}(${target.type})${note}`,
    data: {
      removed: elementId,
      type: target.type,
      trashedFile: target.type === 'file' ? target.path : null,
    },
  };
}
