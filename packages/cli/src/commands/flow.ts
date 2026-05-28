/**
 * `board flow <白板路径> --nodes <json> --edges <json> ...` — 声明式流程图（M5 L3）。
 *
 * 规格：board flow <白板> --nodes '<json>' --edges '<json>'
 *        [--direction TB|BT|LR|RL] [--at "x,y"] [--region <名>] [--arrow <样式>]
 *
 * Agent 只给「节点 + 边 + 方向」，引擎用 dagre 算出互不重叠、按数据流分层的整批
 * 坐标，一次性原子建好全部 shape 节点 + connector 连线，返回每个节点 id → 元素 id。
 * 这是「只表达结构就排好一张流程图」的能力，省去 Agent 逐个 add + 精算坐标。
 *
 * --nodes JSON：[{ "id": "a", "label": "采集", "kind": "rectangle", "width"?, "height"? }, ...]
 * --edges JSON：[{ "from": "a", "to": "b", "label"? }, ...]
 * 节点尺寸：宽默认 160（可显式），高按 label 折行测量（L1，可显式锁定）。
 * 摆放：--at 指定整图左上角；--region 放入区域；都不给则自动找空位（不压现有元素）。
 */
import {
  createShapeElement,
  createConnectorElement,
  layoutFlow,
  nextZ,
  regionsOf,
  placeNearAnchor,
  LAYOUT,
  type FlowDirection,
  type FlowNodeInput,
  type FlowEdgeInput,
  type ShapeKind,
  type ArrowHead,
} from '@board/core';
import type { ParsedArgs } from '../util/args.js';
import { CliError, EXIT, type CmdResult } from '../util/io.js';
import { resolveBoardDir } from '../util/board.js';
import { openBoard } from '../util/board-io.js';
import { resolveActor, buildAgentActivity } from '../util/actor.js';

const VALID_DIRECTIONS: ReadonlySet<string> = new Set(['TB', 'BT', 'LR', 'RL']);
const VALID_KINDS: ReadonlySet<string> = new Set(['rectangle', 'ellipse', 'diamond']);
const VALID_ARROWS: ReadonlySet<string> = new Set(['none', 'arrow', 'triangle', 'dot']);

/** 节点入参（CLI/MCP JSON）—— 比 core 的 FlowNodeInput 多一个 kind。 */
interface NodeSpec extends FlowNodeInput {
  kind?: string;
}

/** 解析 `"x,y"` → {x,y}；缺省返回 null，非法抛 USAGE。 */
function parseAt(raw: string | undefined): { x: number; y: number } | null {
  if (!raw) return null;
  const parts = raw.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) {
    throw new CliError(`--at 必须形如 "x,y"，收到: ${raw}`, EXIT.USAGE);
  }
  return { x: parts[0]!, y: parts[1]! };
}

/** 解析 JSON 数组参数，失败抛 USAGE。 */
function parseJsonArray(raw: string | undefined, flag: string): unknown[] {
  if (raw === undefined) {
    throw new CliError(`缺少 ${flag}（JSON 数组）。`, EXIT.USAGE);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CliError(
      `${flag} 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
      EXIT.USAGE,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new CliError(`${flag} 必须是 JSON 数组。`, EXIT.USAGE);
  }
  return parsed;
}

async function flowAdd(args: ParsedArgs): Promise<CmdResult> {
  const boardPath = args.positionals[0];
  const usage =
    'board flow <白板路径> --nodes \'<json>\' --edges \'<json>\' [--direction TB|BT|LR|RL] [--at "x,y"] [--region <名>] [--arrow <样式>]';
  if (boardPath === undefined) {
    throw new CliError(`缺少白板路径。用法: ${usage}`, EXIT.USAGE);
  }

  // ── 解析 + 校验节点 ──
  const rawNodes = parseJsonArray(args.options.get('nodes'), '--nodes');
  if (rawNodes.length === 0) {
    throw new CliError('--nodes 至少要一个节点。', EXIT.USAGE);
  }
  const nodes: NodeSpec[] = rawNodes.map((n, i) => {
    if (typeof n !== 'object' || n === null) {
      throw new CliError(`--nodes[${i}] 必须是对象。`, EXIT.USAGE);
    }
    const o = n as Record<string, unknown>;
    if (typeof o['id'] !== 'string' || o['id'].trim() === '') {
      throw new CliError(`--nodes[${i}] 缺少非空字符串 id。`, EXIT.USAGE);
    }
    const kind = o['kind'];
    if (kind !== undefined && (typeof kind !== 'string' || !VALID_KINDS.has(kind))) {
      throw new CliError(
        `--nodes[${i}] kind 非法：${String(kind)}。可用: rectangle, ellipse, diamond`,
        EXIT.USAGE,
      );
    }
    return {
      id: o['id'],
      label: typeof o['label'] === 'string' ? o['label'] : undefined,
      kind: kind as string | undefined,
      width: typeof o['width'] === 'number' ? o['width'] : undefined,
      height: typeof o['height'] === 'number' ? o['height'] : undefined,
    };
  });
  const nodeIds = new Set<string>();
  for (const n of nodes) {
    if (nodeIds.has(n.id)) {
      throw new CliError(`--nodes 含重复 id：${n.id}`, EXIT.USAGE);
    }
    nodeIds.add(n.id);
  }

  // ── 解析 + 校验边 ──
  const rawEdges = parseJsonArray(args.options.get('edges') ?? '[]', '--edges');
  const edges: FlowEdgeInput[] = rawEdges.map((e, i) => {
    if (typeof e !== 'object' || e === null) {
      throw new CliError(`--edges[${i}] 必须是对象。`, EXIT.USAGE);
    }
    const o = e as Record<string, unknown>;
    if (typeof o['from'] !== 'string' || typeof o['to'] !== 'string') {
      throw new CliError(`--edges[${i}] 需要字符串 from / to。`, EXIT.USAGE);
    }
    if (!nodeIds.has(o['from'])) {
      throw new CliError(`--edges[${i}] from 引用了未知节点：${o['from']}`, EXIT.NOT_FOUND);
    }
    if (!nodeIds.has(o['to'])) {
      throw new CliError(`--edges[${i}] to 引用了未知节点：${o['to']}`, EXIT.NOT_FOUND);
    }
    return {
      from: o['from'],
      to: o['to'],
      label: typeof o['label'] === 'string' ? o['label'] : undefined,
    };
  });

  // ── 选项 ──
  const directionRaw = (args.options.get('direction') ?? 'TB').trim().toUpperCase();
  if (!VALID_DIRECTIONS.has(directionRaw)) {
    throw new CliError(`--direction 必须为 TB/BT/LR/RL，收到: ${directionRaw}`, EXIT.USAGE);
  }
  const direction = directionRaw as FlowDirection;
  const arrowRaw = args.options.get('arrow') ?? 'arrow';
  if (!VALID_ARROWS.has(arrowRaw)) {
    throw new CliError(`--arrow 必须为 none/arrow/triangle/dot，收到: ${arrowRaw}`, EXIT.USAGE);
  }
  const endArrow = arrowRaw as ArrowHead;
  const at = parseAt(args.options.get('at'));
  const regionName = args.options.get('region')?.trim();

  const dir = resolveBoardDir(boardPath, args.options.get('board'));
  const handle = await openBoard(dir);
  const { scene } = handle;
  const actor = resolveActor(args);

  // ── 确定整图落点 origin + parentId ──
  let parentId: string | null = null;
  let origin: { x: number; y: number };
  if (regionName) {
    const region = regionsOf(scene.elements).find(
      (r) => r.label === regionName || r.path === regionName,
    );
    if (!region) {
      throw new CliError(`未找到区域：${regionName}`, EXIT.NOT_FOUND);
    }
    parentId = region.id;
    origin = at ?? {
      x: region.x + LAYOUT.regionPadding,
      y: region.y + LAYOUT.regionHeaderHeight + LAYOUT.regionPadding,
    };
  } else if (at) {
    origin = at;
  } else {
    // 自动找空位：先在 (0,0) 量出整图包围盒，再用 L2 的锚点外扩搜一块不压现有元素的空地。
    const probe = layoutFlow(nodes, edges, { direction, origin: { x: 0, y: 0 } });
    const occupied = scene.elements
      .filter((e) => e.type !== 'connector')
      .map((e) => ({ x: e.x, y: e.y, width: e.width, height: e.height }));
    origin = placeNearAnchor(
      occupied,
      { width: probe.width, height: probe.height },
      { x: 0, y: 0 },
    );
  }

  // ── dagre 算坐标 ──
  const layout = layoutFlow(nodes, edges, { direction, origin });
  const posById = new Map(layout.nodes.map((n) => [n.id, n]));

  // ── 批量建 shape + connector（精确落，autoPlaced:false）──
  let zCounter = parseInt(nextZ(scene.elements), 36);
  const nextZStr = (): string => (zCounter++).toString(36).padStart(8, '0');

  const nodeElementId = new Map<string, string>();
  const created: Array<{ nodeId: string; elementId: string; x: number; y: number; width: number; height: number }> = [];
  const nodeKind = new Map(nodes.map((n) => [n.id, n.kind]));
  for (const ln of layout.nodes) {
    const el = createShapeElement({
      x: ln.x,
      y: ln.y,
      width: ln.width,
      height: ln.height,
      createdBy: actor,
      z: nextZStr(),
      parentId,
      autoPlaced: false,
      shape: (nodeKind.get(ln.id) ?? 'rectangle') as ShapeKind,
      label: nodes.find((n) => n.id === ln.id)?.label,
    });
    scene.elements.push(el);
    nodeElementId.set(ln.id, el.id);
    created.push({ nodeId: ln.id, elementId: el.id, x: ln.x, y: ln.y, width: ln.width, height: ln.height });
  }

  const connectors: Array<{ elementId: string; from: string; to: string }> = [];
  for (const e of edges) {
    const fromEl = nodeElementId.get(e.from)!;
    const toEl = nodeElementId.get(e.to)!;
    const a = posById.get(e.from)!;
    const b = posById.get(e.to)!;
    const ax = a.x + a.width / 2;
    const ay = a.y + a.height / 2;
    const bx = b.x + b.width / 2;
    const by = b.y + b.height / 2;
    const conn = createConnectorElement({
      x: ax,
      y: ay,
      width: Math.abs(bx - ax),
      height: Math.abs(by - ay),
      createdBy: actor,
      z: nextZStr(),
      start: { elementId: fromEl, anchor: 'auto' },
      end: { elementId: toEl, anchor: 'auto' },
      endArrow,
      routing: 'straight',
      label: e.label,
    });
    scene.elements.push(conn);
    connectors.push({ elementId: conn.id, from: e.from, to: e.to });
  }

  await handle.save(scene);
  const firstNode = created[0];
  await handle.announceAgent(buildAgentActivity(args, actor, firstNode?.elementId));

  return {
    code: EXIT.OK,
    text: `已生成流程图：${created.length} 节点 + ${connectors.length} 连线（${direction}，左上角 ${origin.x},${origin.y}）`,
    data: {
      direction,
      origin,
      bbox: { width: layout.width, height: layout.height },
      nodes: created,
      connectors,
    },
  };
}

/** `board flow` 入口（无子命令）。 */
export async function cmdFlow(args: ParsedArgs): Promise<CmdResult> {
  return flowAdd(args);
}
