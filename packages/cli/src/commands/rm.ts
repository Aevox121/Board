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
import { loadBoard, saveBoard } from '@board/core/node';
import type { ParsedArgs } from '../util/args.js';
import { CliError, EXIT, type CmdResult } from '../util/io.js';
import { resolveBoardDir } from '../util/board.js';

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
  const handle = await loadBoard(dir);
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

  // 移除目标，并连带清理引用它的连线 / 建议（避免悬空引用）。
  const removedRefs: string[] = [];
  const next = scene.elements.filter((e) => {
    if (e.id === elementId) return false;
    if (
      e.type === 'connector' &&
      (e.start.elementId === elementId || e.end.elementId === elementId)
    ) {
      removedRefs.push(e.id);
      return false;
    }
    if (e.type === 'suggestion' && e.targetId === elementId) {
      removedRefs.push(e.id);
      return false;
    }
    return true;
  });

  await saveBoard(dir, handle.meta, { ...scene, elements: next });

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
