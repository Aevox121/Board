/**
 * `board style <白板路径> <元素id> [样式选项]` — 改元素统一样式（PRD §6.7）。
 *
 * 选项（至少给一项）：
 *   --stroke <color>                       描边色
 *   --fill <color>                         填充 / 背景色（`transparent` = 无）
 *   --stroke-width <1-8>                   描边宽度
 *   --stroke-style <solid|dashed|dotted>   描边线型
 *   --opacity <0-100>                      不透明度
 *
 * 统一样式作用于白板上所有元素：图形 / 连线由 Excalidraw 画布层即时反映，
 * 文件 / 文本 / 区域卡片由 DOM 覆盖层据 strokeColor / backgroundColor 反映。
 */
import type { Element, Style, StrokeStyle } from '@board/core';
import type { ParsedArgs } from '../util/args.js';
import { CliError, EXIT, type CmdResult } from '../util/io.js';
import { resolveBoardDir } from '../util/board.js';
import { openBoard } from '../util/board-io.js';
import { resolveActor, buildAgentActivity } from '../util/actor.js';

const VALID_STROKE_STYLE: ReadonlySet<string> = new Set([
  'solid',
  'dashed',
  'dotted',
]);

/** 执行 style 命令。 */
export async function cmdStyle(args: ParsedArgs): Promise<CmdResult> {
  const boardPath = args.positionals[0];
  const elementId = args.positionals[1];
  const usage =
    'board style <白板路径> <元素id> [--stroke <色>] [--fill <色>] [--stroke-width <1-8>] [--stroke-style <solid|dashed|dotted>] [--opacity <0-100>]';
  if (boardPath === undefined || elementId === undefined) {
    throw new CliError(`用法: ${usage}`, EXIT.USAGE);
  }

  // 收集样式补丁
  const patch: Partial<Style> = {};
  const stroke = args.options.get('stroke');
  if (stroke !== undefined) patch.strokeColor = stroke;
  const fill = args.options.get('fill');
  if (fill !== undefined) patch.backgroundColor = fill;
  const swRaw = args.options.get('stroke-width');
  if (swRaw !== undefined) {
    const sw = Number(swRaw);
    if (!Number.isFinite(sw) || sw < 1 || sw > 8) {
      throw new CliError('--stroke-width 必须是 1–8 的数字', EXIT.USAGE);
    }
    patch.strokeWidth = sw;
  }
  const ss = args.options.get('stroke-style');
  if (ss !== undefined) {
    if (!VALID_STROKE_STYLE.has(ss)) {
      throw new CliError('--stroke-style 必须为 solid / dashed / dotted', EXIT.USAGE);
    }
    patch.strokeStyle = ss as StrokeStyle;
  }
  const opRaw = args.options.get('opacity');
  if (opRaw !== undefined) {
    const op = Number(opRaw);
    if (!Number.isFinite(op) || op < 0 || op > 100) {
      throw new CliError('--opacity 必须是 0–100 的数字', EXIT.USAGE);
    }
    patch.opacity = op;
  }
  if (Object.keys(patch).length === 0) {
    throw new CliError(`未提供任何样式选项。用法: ${usage}`, EXIT.USAGE);
  }

  const dir = resolveBoardDir(boardPath, args.options.get('board'));
  const handle = await openBoard(dir);
  const target = handle.scene.elements.find((e) => e.id === elementId);
  if (!target) {
    throw new CliError(`未找到元素：${elementId}`, EXIT.NOT_FOUND);
  }

  const actor = resolveActor(args);
  const ts = new Date().toISOString();
  const next = handle.scene.elements.map((e): Element =>
    e.id === elementId
      ? { ...e, style: { ...e.style, ...patch }, updatedBy: actor, updatedAt: ts }
      : e,
  );
  await handle.save({ ...handle.scene, elements: next });
  await handle.announceAgent(buildAgentActivity(actor, elementId));

  return {
    code: EXIT.OK,
    text: `已更新元素 ${elementId} 的样式（${Object.keys(patch).join(', ')}）`,
    data: { elementId, patch },
  };
}
