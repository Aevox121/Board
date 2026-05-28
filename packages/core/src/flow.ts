/**
 * 声明式图布局（M5 L3 board_add_flow）—— 用 dagre 分层算节点坐标。
 *
 * Agent 只给「节点 + 边 + 方向」，引擎算出互不重叠、按数据流分层的整批坐标。
 * 节点高度复用 L1 `measureLabelHeight`（按 label 折行撑高）；输出 top-left
 * 坐标并按 `origin` 平移到指定锚点。纯函数、不碰场景 —— 调用方（CLI/MCP）
 * 拿坐标批量建 shape + connector（精确落，内部走 forceAt 语义）。
 */
import dagre from '@dagrejs/dagre';
import { measureLabelHeight } from './layout.js';

/** 布局方向：自上而下 / 自下而上 / 自左而右 / 自右而左。 */
export type FlowDirection = 'TB' | 'BT' | 'LR' | 'RL';

export interface FlowNodeInput {
  id: string;
  label?: string;
  /** 显式宽度；省略用 defaultNodeWidth。 */
  width?: number;
  /** 显式高度；省略按 label 在该宽度下折行测量（L1），floor 到 minNodeHeight。 */
  height?: number;
}

export interface FlowEdgeInput {
  from: string;
  to: string;
  label?: string;
}

export interface FlowLayoutOptions {
  direction?: FlowDirection;
  /** 同层相邻节点间距，默认 40。 */
  nodesep?: number;
  /** 相邻层间距，默认 60。 */
  ranksep?: number;
  /** 整图包围盒左上角锚点，默认 {0,0}。 */
  origin?: { x: number; y: number };
  defaultNodeWidth?: number;
  minNodeHeight?: number;
  fontSize?: number;
}

export interface FlowLayoutNode {
  id: string;
  /** 左上角画布坐标。 */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FlowLayoutResult {
  nodes: FlowLayoutNode[];
  /** 整图包围盒尺寸。 */
  width: number;
  height: number;
}

const DEFAULT_NODE_WIDTH = 160;
const MIN_NODE_HEIGHT = 72;
const DEFAULT_FONT_SIZE = 20;

/** 算节点尺寸：显式优先，否则宽=默认、高=按 label 折行测量并 floor 到 min。 */
function nodeSize(
  node: FlowNodeInput,
  defaultWidth: number,
  minHeight: number,
  fontSize: number,
): { width: number; height: number } {
  const width = node.width ?? defaultWidth;
  let height = node.height ?? minHeight;
  if (node.height === undefined && node.label) {
    height = Math.max(minHeight, measureLabelHeight(node.label, width, fontSize));
  }
  return { width, height };
}

/**
 * 用 dagre 给一张有向图算分层坐标。
 *
 * @throws 边引用了不存在的节点 id 时 dagre 会抛错；调用方应先校验。
 */
export function layoutFlow(
  nodes: FlowNodeInput[],
  edges: FlowEdgeInput[],
  opts: FlowLayoutOptions = {},
): FlowLayoutResult {
  if (nodes.length === 0) return { nodes: [], width: 0, height: 0 };

  const direction = opts.direction ?? 'TB';
  const nodesep = opts.nodesep ?? 40;
  const ranksep = opts.ranksep ?? 60;
  const origin = opts.origin ?? { x: 0, y: 0 };
  const defaultWidth = opts.defaultNodeWidth ?? DEFAULT_NODE_WIDTH;
  const minHeight = opts.minNodeHeight ?? MIN_NODE_HEIGHT;
  const fontSize = opts.fontSize ?? DEFAULT_FONT_SIZE;

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: direction, nodesep, ranksep, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));

  const sizes = new Map<string, { width: number; height: number }>();
  for (const n of nodes) {
    const s = nodeSize(n, defaultWidth, minHeight, fontSize);
    sizes.set(n.id, s);
    g.setNode(n.id, { width: s.width, height: s.height });
  }
  for (const e of edges) {
    g.setEdge(e.from, e.to);
  }

  dagre.layout(g);

  // dagre 给「中心」坐标 —— 转 top-left，求包围盒后整体平移到 origin。
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const raw: Array<{ id: string; left: number; top: number; w: number; h: number }> = [];
  for (const n of nodes) {
    const dn = g.node(n.id) as { x: number; y: number } | undefined;
    const s = sizes.get(n.id)!;
    // dagre 理论上为每个 setNode 的节点都给坐标；防御性兜底到 0。
    const cx = dn?.x ?? 0;
    const cy = dn?.y ?? 0;
    const left = cx - s.width / 2;
    const top = cy - s.height / 2;
    raw.push({ id: n.id, left, top, w: s.width, h: s.height });
    minX = Math.min(minX, left);
    minY = Math.min(minY, top);
    maxX = Math.max(maxX, left + s.width);
    maxY = Math.max(maxY, top + s.height);
  }

  const dx = origin.x - minX;
  const dy = origin.y - minY;
  const outNodes: FlowLayoutNode[] = raw.map((r) => ({
    id: r.id,
    x: Math.round(r.left + dx),
    y: Math.round(r.top + dy),
    width: r.w,
    height: r.h,
  }));
  return {
    nodes: outNodes,
    width: Math.round(maxX - minX),
    height: Math.round(maxY - minY),
  };
}
