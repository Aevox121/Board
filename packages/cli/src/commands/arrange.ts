/**
 * `board arrange <白板路径> ...` — 把一批元素重排成整齐布局（M5 L3）。
 *
 * 规格：board arrange <白板> (--ids "id1,id2,..." | --region <名>)
 *        --layout <grid|row|column> [--gap <px>] [--cols <n>] [--at "x,y"]
 *
 * 与 L2「摆放仲裁」分工：L2 只保证新增元素不堆叠（找最近空位），本命令负责把
 * 一批**已有**元素排成语义对齐的布局（网格 / 行 / 列）。算完整批坐标后一次性
 * 原子写回（handle.save 整场景 PUT），不做二次避让。
 *
 * 目标元素来源二选一：
 *  - `--ids`：显式元素 id 列表（逗号分隔），按给定顺序排布；
 *  - `--region`：该区域内的全部子元素（parentId == 区域 id），按场景顺序排布。
 *
 * 排除 connector（位置由两端派生，跟随端点自动移动）与 region / folder
 * （容器，移动它不会带动其绝对定位的子元素 —— 移容器属后续工作）。
 */
import {
  arrangeElements,
  regionsOf,
  type ArrangeItem,
  type ArrangeLayout,
  type Element,
} from '@board/core';
import type { ParsedArgs } from '../util/args.js';
import { CliError, EXIT, type CmdResult } from '../util/io.js';
import { resolveBoardDir } from '../util/board.js';
import { openBoard } from '../util/board-io.js';
import { resolveActor, buildAgentActivity } from '../util/actor.js';

/** 可参与排版的元素类型（排除 connector / region / folder）。 */
const ARRANGEABLE: ReadonlySet<Element['type']> = new Set([
  'text',
  'shape',
  'file',
  'image',
  'embed',
  'draw',
]);

const VALID_LAYOUTS: ReadonlySet<string> = new Set(['grid', 'row', 'column']);

/** 解析 `"x,y"` → `[x,y]`；缺省返回 null，非法抛 USAGE。 */
function parseOrigin(raw: string | undefined): { x: number; y: number } | null {
  if (!raw) return null;
  const parts = raw.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) {
    throw new CliError(`--at 必须形如 "x,y"（两个数字），收到: ${raw}`, EXIT.USAGE);
  }
  return { x: parts[0]!, y: parts[1]! };
}

async function cmdArrange(args: ParsedArgs): Promise<CmdResult> {
  const boardPath = args.positionals[0];
  const usage =
    'board arrange <白板路径> (--ids "id1,id2,..." | --region <名>) --layout <grid|row|column> [--gap <px>] [--cols <n>] [--at "x,y"]';
  if (boardPath === undefined) {
    throw new CliError(`缺少白板路径。用法: ${usage}`, EXIT.USAGE);
  }

  const layout = (args.options.get('layout') ?? 'grid').trim();
  if (!VALID_LAYOUTS.has(layout)) {
    throw new CliError(
      `未知布局: ${layout}。可用: grid, row, column（tree / 层级图请用 board_add_flow）`,
      EXIT.USAGE,
    );
  }

  const idsRaw = args.options.get('ids');
  const regionName = args.options.get('region')?.trim();
  if (!idsRaw && !regionName) {
    throw new CliError(`需指定 --ids 或 --region。用法: ${usage}`, EXIT.USAGE);
  }
  if (idsRaw && regionName) {
    throw new CliError('--ids 与 --region 互斥，二选一。', EXIT.USAGE);
  }

  const gapRaw = args.options.get('gap');
  const gap = gapRaw !== undefined ? Number(gapRaw) : undefined;
  if (gap !== undefined && (!Number.isFinite(gap) || gap < 0)) {
    throw new CliError(`--gap 必须为非负数，收到: ${gapRaw}`, EXIT.USAGE);
  }
  const colsRaw = args.options.get('cols');
  const cols = colsRaw !== undefined ? Number(colsRaw) : undefined;
  if (cols !== undefined && (!Number.isInteger(cols) || cols < 1)) {
    throw new CliError(`--cols 必须为正整数，收到: ${colsRaw}`, EXIT.USAGE);
  }
  const origin = parseOrigin(args.options.get('at'));

  const dir = resolveBoardDir(boardPath, args.options.get('board'));
  const handle = await openBoard(dir);
  const { scene } = handle;
  const byId = new Map(scene.elements.map((e) => [e.id, e]));

  // 解析目标元素（保序）。
  let ordered: Element[];
  if (idsRaw) {
    const ids = idsRaw.split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) {
      throw new CliError('--ids 为空。', EXIT.USAGE);
    }
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new CliError(`未找到元素：${missing.join(', ')}`, EXIT.NOT_FOUND);
    }
    ordered = ids.map((id) => byId.get(id)!);
  } else {
    const region = regionsOf(scene.elements).find(
      (r) => r.label === regionName || r.path === regionName,
    );
    if (!region) {
      throw new CliError(`未找到区域：${regionName}`, EXIT.NOT_FOUND);
    }
    ordered = scene.elements.filter((e) => e.parentId === region.id);
  }

  // 过滤到可排版类型。
  const skipped = ordered.filter((e) => !ARRANGEABLE.has(e.type));
  const targets = ordered.filter((e) => ARRANGEABLE.has(e.type));
  if (targets.length === 0) {
    throw new CliError(
      '没有可排版的元素（connector / region / folder 不参与排版）。',
      EXIT.USAGE,
    );
  }

  const items: ArrangeItem[] = targets.map((e) => ({
    id: e.id,
    x: e.x,
    y: e.y,
    width: e.width,
    height: e.height,
  }));
  const placements = arrangeElements(items, layout as ArrangeLayout, {
    gap,
    cols,
    origin: origin ?? undefined,
  });
  const posById = new Map(placements.map((p) => [p.id, p]));

  const actor = resolveActor(args);
  const ts = new Date().toISOString();
  const next = scene.elements.map((e): Element => {
    const p = posById.get(e.id);
    if (!p) return e;
    return { ...e, x: p.x, y: p.y, autoPlaced: false, updatedBy: actor, updatedAt: ts };
  });
  await handle.save({ ...scene, elements: next });
  await handle.announceAgent(buildAgentActivity(args, actor));

  const skippedNote =
    skipped.length > 0 ? `（跳过 ${skipped.length} 个不可排版元素）` : '';
  return {
    code: EXIT.OK,
    text: `已按 ${layout} 排版 ${targets.length} 个元素${skippedNote}`,
    data: {
      layout,
      count: targets.length,
      skipped: skipped.map((e) => ({ id: e.id, type: e.type })),
      placements,
    },
  };
}

/** `board arrange` 入口（无子命令）。 */
export async function cmdArrangeCommand(args: ParsedArgs): Promise<CmdResult> {
  return cmdArrange(args);
}
