/**
 * `board mv <白板路径> <源相对路径> <目标相对路径>` — 移动 files/ 内的文件。
 *
 * 规格 §2.2：把 `files/` 下的一个文件改名 / 移动到新的相对路径。这是「画布 →
 * 文件系统」方向的命令行入口，与 Web 端拖拽文件卡改归属等价 —— Agent 默认经
 * CLI 操作白板。
 *
 * 移动后 reconcile：移动检测命中后更新该 file 元素的 path / parentId，
 * 并按新所属区域自动归位（不删旧建新，R5 路径即真相）。
 */
import { mkdir, rename, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { loadBoard, saveBoard, listBoardFiles } from '@board/core/node';
import { reconcileFiles, normalizePath } from '@board/core';
import type { ParsedArgs } from '../util/args.js';
import { CliError, EXIT, type CmdResult } from '../util/io.js';
import { resolveBoardDir } from '../util/board.js';

/** M2 默认参与者 id —— 无 `--actor` 时归属于此。 */
const DEFAULT_ACTOR = 'u_local';

/** 校验相对路径不含 `..` 段。 */
function assertNoDotDot(rel: string, label: string): void {
  if (rel.split('/').includes('..')) {
    throw new CliError(`${label}不能包含 ".."：${rel}`, EXIT.USAGE);
  }
}

/**
 * 执行 mv 命令。
 *
 * @param args 位置参数[0]=白板路径，[1]=源相对路径，[2]=目标相对路径（均相对 files/）
 */
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
  const handle = await loadBoard(dir);

  // 防目录穿越：解析后必须仍落在 files/ 内
  const filesRoot = join(dir, 'files');
  const fromAbs = join(filesRoot, from);
  const toAbs = join(filesRoot, to);
  const rootPrefix = filesRoot.endsWith(sep) ? filesRoot : filesRoot + sep;
  if (
    !resolve(fromAbs).startsWith(rootPrefix) ||
    !resolve(toAbs).startsWith(rootPrefix)
  ) {
    throw new CliError('路径越出 files/ 范围。', EXIT.USAGE);
  }

  // 源必须是已存在的文件；目标不得已存在
  if (!existsSync(fromAbs)) {
    throw new CliError(`源文件不存在: files/${from}`, EXIT.NOT_FOUND);
  }
  const fromStat = await stat(fromAbs);
  if (!fromStat.isFile()) {
    throw new CliError(`源路径不是文件: files/${from}`, EXIT.USAGE);
  }
  if (existsSync(toAbs)) {
    throw new CliError(`目标已存在: files/${to}`, EXIT.CONFLICT);
  }

  // 建目标父目录并重命名
  await mkdir(dirname(toAbs), { recursive: true });
  await rename(fromAbs, toAbs);

  // reconcile：移动检测把该 file 元素重定位到新路径并按区域自动归位
  const diskFiles = await listBoardFiles(dir);
  const actor = args.options.get('actor') ?? DEFAULT_ACTOR;
  const result = reconcileFiles({ scene: handle.scene, diskFiles, actor });
  await saveBoard(dir, handle.meta, result.scene);

  return {
    code: EXIT.OK,
    text:
      `已移动 files/${from} → files/${to}` +
      `  (重定位 ${result.moved.length} / 新增 ${result.added.length} 个 file 元素)`,
    data: {
      from,
      to,
      added: result.added,
      moved: result.moved,
    },
  };
}
