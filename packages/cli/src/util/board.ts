/**
 * 白板定位工具 — 解析命令传入的白板路径。
 *
 * 规格 §1.2：`--board <path>` 指定白板目录；
 * 省略时取当前目录向上最近的 `.board`。
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { CliError, EXIT } from './io.js';

/** 判断一个路径是否为有效的 .board 目录（含 board.json）。 */
function isBoardDir(p: string): boolean {
  try {
    return statSync(p).isDirectory() && existsSync(join(p, 'board.json'));
  } catch {
    return false;
  }
}

/**
 * 从当前目录向上查找最近的 `.board` 目录。
 * 找不到返回 null。
 */
function findBoardUpwards(startDir: string): string | null {
  let dir = resolve(startDir);
  // 当前目录本身就是 .board 目录
  if (dir.endsWith('.board') && isBoardDir(dir)) return dir;

  while (true) {
    // 当前目录下若恰有一个 .board，可向上识别其父目录场景在此不展开；
    // 规格要求「向上最近的 .board」，即祖先链上以 .board 结尾的目录。
    if (dir.endsWith('.board') && isBoardDir(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * 解析命令使用的白板目录。
 *
 * 优先级：显式参数 > `--board` 选项 > 当前目录向上查找。
 *
 * @param explicitPath 命令位置参数中给出的路径（可空）
 * @param boardOption  `--board` 选项值（可空）
 * @returns .board 目录的绝对路径
 * @throws CliError 路径无效或找不到白板（退出码 3）
 */
export function resolveBoardDir(
  explicitPath: string | undefined,
  boardOption: string | undefined,
): string {
  const candidate = explicitPath ?? boardOption;

  if (candidate !== undefined) {
    const abs = isAbsolute(candidate)
      ? candidate
      : resolve(process.cwd(), candidate);
    if (!existsSync(abs)) {
      throw new CliError(`白板路径不存在: ${candidate}`, EXIT.NOT_FOUND);
    }
    if (!isBoardDir(abs)) {
      throw new CliError(
        `不是有效的白板目录（缺少 board.json）: ${candidate}`,
        EXIT.NOT_FOUND,
      );
    }
    return abs;
  }

  const found = findBoardUpwards(process.cwd());
  if (found === null) {
    throw new CliError(
      '未找到白板：请用 --board <path> 指定，或在 .board 目录内执行。',
      EXIT.NOT_FOUND,
    );
  }
  return found;
}
