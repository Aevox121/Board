/**
 * `board shape add <白板路径> <rectangle|ellipse|diamond> ...` — 添加几何图形。
 *
 * 规格 §2.3：board shape add <kind> [--at <x,y>] [--size <w,h>]
 *            [--label "<文字>"] [--region <名>]
 *
 * 图形归 Excalidraw 画布层渲染（手绘风方框/圆/菱形）—— Agent 用来画流程图。
 * 手绘（freedraw）不开放给 Agent（PRD §7.2 决策点 10）。
 */
import {
  createShapeElement,
  DEFAULT_STYLE,
  measureLabelHeight,
  nextZ,
  regionsOf,
  INBOX_RECT,
  type ShapeKind,
} from '@board/core';
import type { ParsedArgs } from '../util/args.js';
import { CliError, EXIT, type CmdResult } from '../util/io.js';
import { resolveBoardDir } from '../util/board.js';
import { openBoard } from '../util/board-io.js';
import { resolveActor, buildAgentActivity } from '../util/actor.js';
import { autoPlace, autoPlaceNear } from '../util/layout.js';

/** 流程图方框默认尺寸。 */
const DEFAULT_SHAPE_SIZE = { width: 160, height: 72 };
/** 支持的图形类型。 */
const VALID_KINDS: ReadonlySet<string> = new Set([
  'rectangle',
  'ellipse',
  'diamond',
]);

/** 解析 `"a,b"` → `[a,b]`；缺省 / 非法返回 null。 */
function parsePair(raw: string | undefined): [number, number] | null {
  if (!raw) return null;
  const parts = raw.split(',').map((s) => Number(s.trim()));
  const a = parts[0];
  const b = parts[1];
  if (
    parts.length === 2 &&
    a !== undefined &&
    b !== undefined &&
    Number.isFinite(a) &&
    Number.isFinite(b)
  ) {
    return [a, b];
  }
  return null;
}

/** `board shape add ...` */
async function shapeAdd(args: ParsedArgs): Promise<CmdResult> {
  const boardPath = args.positionals[0];
  const kind = args.positionals[1];
  const usage =
    'board shape add <白板路径> <rectangle|ellipse|diamond> [--at x,y] [--size w,h] [--label "<文字>"] [--region <名>]';
  if (boardPath === undefined) {
    throw new CliError(`缺少白板路径。用法: ${usage}`, EXIT.USAGE);
  }
  if (kind === undefined) {
    throw new CliError('缺少图形类型。可用: rectangle, ellipse, diamond', EXIT.USAGE);
  }
  if (!VALID_KINDS.has(kind)) {
    throw new CliError(
      `未知图形类型: ${kind}。可用: rectangle, ellipse, diamond`,
      EXIT.USAGE,
    );
  }

  const dir = resolveBoardDir(boardPath, args.options.get('board'));
  const handle = await openBoard(dir);
  const { scene } = handle;
  const actor = resolveActor(args);
  const z = nextZ(scene.elements);

  const size = parsePair(args.options.get('size'));
  const label = args.options.get('label');
  const width = size ? size[0] : DEFAULT_SHAPE_SIZE.width;
  // M5 L1 自适应高度：未显式给 --size 且有 label 时，按 label 折行后所需高度
  // 撑大盒子（≥默认高），杜绝 label 溢出方框（出框）。给了 --size 即尊重用户值。
  let height = size ? size[1] : DEFAULT_SHAPE_SIZE.height;
  if (!size && label) {
    height = Math.max(
      DEFAULT_SHAPE_SIZE.height,
      measureLabelHeight(label, width, DEFAULT_STYLE.fontSize),
    );
  }

  // 摆放（M5 L2 仲裁）：--force-at 硬坐标 / --at 锚点避让 / 缺省自动落位。
  // --region 时容器为该区域，否则为收件区（顶层）。
  const forceAt = parsePair(args.options.get('force-at'));
  const at = parsePair(args.options.get('at'));
  const regionName = args.options.get('region')?.trim();
  let parentId: string | null = null;
  let x: number;
  let y: number;
  let nudged = false;
  let region: ReturnType<typeof regionsOf>[number] | undefined;
  if (regionName) {
    region = regionsOf(scene.elements).find(
      (r) => r.label === regionName || r.path === regionName,
    );
    if (!region) {
      throw new CliError(`未找到区域：${regionName}`, EXIT.NOT_FOUND);
    }
    parentId = region.id;
  }
  if (forceAt) {
    [x, y] = forceAt;
  } else if (at) {
    const pos = autoPlaceNear(
      scene.elements,
      parentId,
      { x: at[0], y: at[1] },
      { width, height },
      region ? region.width : undefined,
    );
    x = pos.x;
    y = pos.y;
    nudged = pos.nudged;
  } else {
    const container = region ?? INBOX_RECT;
    const pos = autoPlace(scene.elements, parentId, container, { width, height });
    x = pos.x;
    y = pos.y;
  }

  const element = createShapeElement({
    x,
    y,
    width,
    height,
    createdBy: actor,
    z,
    parentId,
    autoPlaced: forceAt === null && at === null,
    shape: kind as ShapeKind,
    label,
  });
  scene.elements.push(element);
  await handle.save(scene);
  await handle.announceAgent(buildAgentActivity(args, actor, element.id));

  return {
    code: EXIT.OK,
    text: `已添加 ${kind} 图形 ${element.id}${label ? `「${label}」` : ''}  (at ${x},${y})${nudged ? ' [已避让]' : ''}`,
    data: {
      elementId: element.id,
      shape: kind,
      x,
      y,
      width,
      height,
      label: label ?? null,
      placedAt: { x, y },
      nudged,
    },
  };
}

/** `board shape` 分发。 */
export async function cmdShape(args: ParsedArgs): Promise<CmdResult> {
  const sub = args.positionals[0];
  if (sub !== 'add') {
    throw new CliError(
      `未知子命令 "shape ${sub ?? ''}"。可用: add`,
      EXIT.USAGE,
    );
  }
  return shapeAdd({
    positionals: args.positionals.slice(1),
    flags: args.flags,
    options: args.options,
  });
}
