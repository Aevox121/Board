/**
 * `board rm <白板路径> <元素id>` — 删除元素。
 *
 * 规格 §2.2：删除元素。`file` 元素的真实文件移入回收站 `.runtime/trash/`
 * （可恢复，导出时随 .runtime 一并剔除）。同时清理引用该元素的连线与建议，
 * 避免悬空。`region` / `folder` 元素背后是真实文件夹，不在本命令删除范围。
 */
import { mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { removeElement } from '@board/core';
import type { ParsedArgs } from '../util/args.js';
import { CliError, EXIT, type CmdResult } from '../util/io.js';
import { resolveBoardDir } from '../util/board.js';
import { openBoard } from '../util/board-io.js';

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
  const { scene } = handle;
  const target = scene.elements.find((e) => e.id === elementId);
  if (!target) {
    throw new CliError(`未找到元素：${elementId}`, EXIT.NOT_FOUND);
  }
  if (target.type === 'region' || target.type === 'folder') {
    throw new CliError(
      `不支持用 rm 删除 ${target.type} 元素（其背后是真实文件夹，请直接操作文件夹）。`,
      EXIT.USAGE,
    );
  }

  // 移除目标，并连带清理引用它的连线 / 建议（避免悬空引用），先落盘。
  // 顺序要点：先存「不含该元素」的 board.json、再动真实文件 —— 否则正在
  // 监听该白板的 board-server 会在文件消失瞬间 reconcile，把仍在 board.json
  // 里的该 file 元素当缺失态保留并回写，覆盖掉本次删除。
  const { scene: next, removedRefs } = removeElement(scene, elementId);
  await handle.save(next);

  // file 元素：真实文件移入回收站 .runtime/trash/（可恢复）。
  let trashed: string | null = null;
  if (target.type === 'file') {
    const src = join(dir, 'files', target.path);
    if (existsSync(src)) {
      const trashDir = join(dir, '.runtime', 'trash');
      await mkdir(trashDir, { recursive: true });
      await rename(src, join(trashDir, `${Date.now()}-${basename(target.path)}`));
      trashed = target.path;
    }
  }

  return {
    code: EXIT.OK,
    text:
      `已删除元素 ${elementId}（${target.type}）` +
      (trashed ? '，文件移入回收站' : '') +
      (removedRefs.length > 0
        ? `；连带清理 ${removedRefs.length} 个引用元素`
        : ''),
    data: {
      removed: elementId,
      type: target.type,
      trashedFile: trashed,
      removedRefs,
    },
  };
}
