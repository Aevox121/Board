/**
 * `board ls` — 列出当前目录（及一层子目录）下的 `.board` 文件夹。
 *
 * 规格 §2.1：列出本机已知白板。M1 简化为扫描当前目录与其直接子目录。
 */
import { readdirSync, existsSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { loadBoard } from '@board/core/node';
import type { ParsedArgs } from '../util/args.js';
import { EXIT, type CmdResult } from '../util/io.js';

/** 一个被发现的白板条目。 */
interface BoardEntry {
  dir: string;
  id: string;
  name: string;
}

/** 判断目录是否为有效 .board（含 board.json）。 */
function isBoardDir(p: string): boolean {
  try {
    return (
      p.endsWith('.board') &&
      statSync(p).isDirectory() &&
      existsSync(join(p, 'board.json'))
    );
  } catch {
    return false;
  }
}

/** 列出某目录下直接子项中的 .board 目录。 */
function scanDir(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = join(dir, e.name);
    if (isBoardDir(full)) out.push(full);
  }
  return out;
}

/**
 * 执行 ls 命令。
 *
 * 扫描当前目录与其一层子目录，收集所有 `.board` 文件夹。
 */
export async function cmdLs(_args: ParsedArgs): Promise<CmdResult> {
  const cwd = process.cwd();
  const found = new Set<string>();

  // 当前目录直接子项
  for (const p of scanDir(cwd)) found.add(p);

  // 下钻一层：当前目录里每个非 .board 子目录再扫一次
  let topEntries: Dirent[];
  try {
    topEntries = readdirSync(cwd, { withFileTypes: true });
  } catch {
    topEntries = [];
  }
  for (const e of topEntries) {
    if (!e.isDirectory() || e.name.endsWith('.board')) continue;
    for (const p of scanDir(join(cwd, e.name))) found.add(p);
  }

  const boards: BoardEntry[] = [];
  for (const dir of [...found].sort()) {
    try {
      const handle = await loadBoard(dir);
      boards.push({ dir, id: handle.meta.id, name: handle.meta.name });
    } catch {
      // 损坏的 .board 跳过，不影响其余列举
    }
  }

  const text =
    boards.length === 0
      ? '当前目录（及一层子目录）下未发现白板。'
      : boards
          .map((b) => `${b.id}  ${b.name}\n  ${b.dir}`)
          .join('\n');

  return { code: EXIT.OK, text, data: { boards } };
}
