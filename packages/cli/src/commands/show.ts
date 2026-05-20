/**
 * `board show <路径> [--json]` — 输出基础白板上下文。
 *
 * 规格 §2.4：导出白板上下文（Board Context）供 Agent 理解。
 * M1 实现概览级（depth 0）：名称 + 各元素类型计数 + 文件列表。
 */
import { loadBoard, listBoardFiles } from '@board/core/node';
import type { ElementType } from '@board/core';
import type { ParsedArgs } from '../util/args';
import { EXIT, type CmdResult } from '../util/io';
import { resolveBoardDir } from '../util/board';

/**
 * 执行 show 命令。
 *
 * @param args 位置参数[0] = 白板路径
 */
export async function cmdShow(args: ParsedArgs): Promise<CmdResult> {
  const dir = resolveBoardDir(args.positionals[0], args.options.get('board'));
  const handle = await loadBoard(dir);
  const files = await listBoardFiles(dir);

  // 按元素类型计数
  const counts: Partial<Record<ElementType, number>> = {};
  for (const el of handle.scene.elements) {
    counts[el.type] = (counts[el.type] ?? 0) + 1;
  }

  const data = {
    name: handle.meta.name,
    elementCount: handle.scene.elements.length,
    elementTypes: counts,
    files,
  };

  const typeLines = Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, n]) => `  ${type}: ${n}`);

  const text = [
    `白板: ${data.name}`,
    `元素总数: ${data.elementCount}`,
    typeLines.length > 0 ? '元素类型计数:' : '元素类型计数: （无元素）',
    ...typeLines,
    `文件 (${files.length}):`,
    ...(files.length > 0 ? files.map((f) => `  ${f}`) : ['  （无文件）']),
  ].join('\n');

  return { code: EXIT.OK, text, data };
}
