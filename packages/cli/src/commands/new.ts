/**
 * `board new <名称> [--dir <父目录>]` — 新建白板。
 *
 * 规格 §2.1：建 `.board` 目录结构。
 */
import { isAbsolute, resolve } from 'node:path';
import { createBoardFolder, loadBoard } from '@board/core/node';
import type { ParsedArgs } from '../util/args.js';
import { CliError, EXIT, type CmdResult } from '../util/io.js';

/**
 * 执行 new 命令。
 *
 * @param args 解析后的参数：位置参数[0] = 白板名称；`--dir` = 父目录（默认当前目录）
 */
export async function cmdNew(args: ParsedArgs): Promise<CmdResult> {
  const name = args.positionals[0];
  if (name === undefined || name.trim() === '') {
    throw new CliError(
      '缺少白板名称。用法: board new <名称> [--dir <父目录>]',
      EXIT.USAGE,
    );
  }

  const dirOpt = args.options.get('dir') ?? '.';
  const parentDir = isAbsolute(dirOpt) ? dirOpt : resolve(process.cwd(), dirOpt);

  const boardDir = await createBoardFolder(parentDir, name);
  const handle = await loadBoard(boardDir);

  return {
    code: EXIT.OK,
    text: `已创建 ${boardDir}  (id: ${handle.meta.id})`,
    data: {
      dir: boardDir,
      id: handle.meta.id,
      name: handle.meta.name,
    },
  };
}
