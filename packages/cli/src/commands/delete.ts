/**
 * `board delete <.board 目录>` — 删除白板。
 *
 * 与文件元素删除（PRD §5.7 R6 移入 files/_trash/）的精神一致：白板级删除
 * 也不真删 —— 把整个 `.board` 文件夹移到同级 `_trash/<timestamp>-<basename>`，
 * 需要时人工恢复。
 *
 * 如果对应 board 当前正被 board-server 加载，建议先 `DELETE /api/boards/<id>`
 * 让 server 先关 runtime 再处理 fs；本命令是离线的 fs 操作，server 在跑时
 * 直接 rename 会让 chokidar 看到目录消失但 runtime 还在，行为不可预期。
 *
 * 规格 §2.1：补完白板生命周期（new → delete）。
 */
import { mkdir, rename, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { loadBoard } from '@board/core/node';
import type { ParsedArgs } from '../util/args.js';
import { CliError, EXIT, type CmdResult } from '../util/io.js';

/**
 * 执行 delete 命令。
 *
 * @param args 位置参数[0] = .board 目录路径
 */
export async function cmdDelete(args: ParsedArgs): Promise<CmdResult> {
  const target = args.positionals[0];
  if (target === undefined || target.trim() === '') {
    throw new CliError(
      '缺少白板路径。用法: board delete <.board 目录>',
      EXIT.USAGE,
    );
  }

  const abs = isAbsolute(target) ? target : resolve(process.cwd(), target);

  // 校验目标是有效 .board —— 不让用户误删非 board 目录
  let st;
  try {
    st = await stat(abs);
  } catch {
    throw new CliError(`目录不存在: ${abs}`, EXIT.NOT_FOUND);
  }
  if (!st.isDirectory()) {
    throw new CliError(`不是目录: ${abs}`, EXIT.USAGE);
  }
  if (!abs.endsWith('.board')) {
    throw new CliError(`不是 .board 目录（命名不符）: ${abs}`, EXIT.USAGE);
  }
  let name: string;
  try {
    const handle = await loadBoard(abs);
    name = handle.meta.name;
  } catch (err) {
    throw new CliError(
      `加载 board.json 失败（可能已损坏 / 非 board）: ${err instanceof Error ? err.message : String(err)}`,
      EXIT.GENERAL,
    );
  }

  // 移到同级 _trash/<timestamp>-<basename>
  const parent = dirname(abs);
  const trashRoot = join(parent, '_trash');
  await mkdir(trashRoot, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = join(trashRoot, `${ts}-${basename(abs)}`);
  try {
    await rename(abs, dest);
  } catch (err) {
    throw new CliError(
      `移动 ${abs} → _trash/ 失败: ${err instanceof Error ? err.message : String(err)}`,
      EXIT.GENERAL,
    );
  }

  return {
    code: EXIT.OK,
    text: `已删除「${name}」 — ${abs} → ${dest}`,
    data: { from: abs, to: dest, name },
  };
}
