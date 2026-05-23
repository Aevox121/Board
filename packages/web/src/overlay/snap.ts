/**
 * 拖拽吸附与对齐参考线 —— 把被拖元素（并集包围盒）的边 / 中线吸附到画布上
 * 其它元素的对应线，并算出需要绘制的参考线。Excalidraw 风格的对齐辅助。
 *
 * 纯几何，无 React 依赖 —— OverlayLayer 在 handlePointerMove 中调用。
 */
import type { RectLike } from './util';

/** 一条对齐参考线（画布坐标）。axis='x' 为竖线（x 固定）、'y' 为横线。 */
export interface SnapGuide {
  axis: 'x' | 'y';
  /** 参考线所在坐标 —— axis='x' 取作 x，'y' 取作 y。 */
  pos: number;
  /** 参考线沿另一轴的跨度起点（覆盖被拖框与对齐到的参照元素）。 */
  from: number;
  /** 参考线沿另一轴的跨度终点。 */
  to: number;
}

/** 吸附结果 —— 修正后的偏移 + 要绘制的参考线。 */
export interface SnapResult {
  dx: number;
  dy: number;
  guides: SnapGuide[];
}

/** 两条吸附线视作「同一条」的容差（画布单位）。 */
const SAME_LINE_EPS = 0.5;

/** 矩形上参与吸附的三条线之一：起边 / 中线 / 止边。 */
export type SnapEdge = 'start' | 'center' | 'end';

/** 矩形在某轴上的三条吸附线：起边 / 中线 / 止边。 */
function linesOf(r: RectLike, axis: 'x' | 'y'): [number, number, number] {
  return axis === 'x'
    ? [r.x, r.x + r.width / 2, r.x + r.width]
    : [r.y, r.y + r.height / 2, r.y + r.height];
}

/** 给一组活动边返回其坐标 —— 缩放时活动边由手柄方向决定（如右下 = {x:'end', y:'end'}）。 */
function activeLinePositions(
  r: RectLike,
  axis: 'x' | 'y',
  edges: ReadonlyArray<SnapEdge>,
): number[] {
  const all = linesOf(r, axis);
  return edges.map((e) =>
    e === 'start' ? all[0] : e === 'center' ? all[1] : all[2],
  );
}

/** 在某轴上挑出离参照线最近、且在阈值内的吸附（返回偏移量与吸附线坐标）。 */
function pickAxis(
  dragged: RectLike,
  axis: 'x' | 'y',
  refs: ReadonlyArray<RectLike>,
  threshold: number,
  draggedLines?: number[],
): { delta: number; line: number } | null {
  const dLines = draggedLines ?? linesOf(dragged, axis);
  let best: { delta: number; line: number } | null = null;
  for (const ref of refs) {
    for (const rl of linesOf(ref, axis)) {
      for (const dl of dLines) {
        const delta = rl - dl;
        if (Math.abs(delta) > threshold) continue;
        if (!best || Math.abs(delta) < Math.abs(best.delta)) {
          best = { delta, line: rl };
        }
      }
    }
  }
  return best;
}

/**
 * 参考线跨度 —— 沿另一轴覆盖「吸附后的被拖框」加上所有对齐到 `line` 的参照
 * 元素，使参考线一眼能连起所有对齐的图形。
 */
function spanGuide(
  axis: 'x' | 'y',
  line: number,
  snapped: RectLike,
  refs: ReadonlyArray<RectLike>,
): SnapGuide {
  let from = axis === 'x' ? snapped.y : snapped.x;
  let to =
    axis === 'x' ? snapped.y + snapped.height : snapped.x + snapped.width;
  for (const ref of refs) {
    const aligned = linesOf(ref, axis).some(
      (l) => Math.abs(l - line) < SAME_LINE_EPS,
    );
    if (!aligned) continue;
    from = Math.min(from, axis === 'x' ? ref.y : ref.x);
    to = Math.max(
      to,
      axis === 'x' ? ref.y + ref.height : ref.x + ref.width,
    );
  }
  return { axis, pos: line, from, to };
}

/**
 * 计算拖拽吸附。
 *
 * @param dragged   被拖元素的并集包围盒 —— **已应用原始偏移**后的位置。
 * @param rawDx/rawDy 原始偏移（吸附在此基础上微调）。
 * @param refs      参照矩形（非被拖、非连线的元素）。
 * @param threshold 吸附阈值（画布单位）。
 */
export function computeSnap(
  dragged: RectLike,
  rawDx: number,
  rawDy: number,
  refs: ReadonlyArray<RectLike>,
  threshold: number,
): SnapResult {
  if (refs.length === 0) return { dx: rawDx, dy: rawDy, guides: [] };
  const bx = pickAxis(dragged, 'x', refs, threshold);
  const by = pickAxis(dragged, 'y', refs, threshold);
  const dx = rawDx + (bx ? bx.delta : 0);
  const dy = rawDy + (by ? by.delta : 0);
  // 吸附后的被拖框 —— 用于参考线跨度计算。
  const snapped: RectLike = {
    x: dragged.x + (bx ? bx.delta : 0),
    y: dragged.y + (by ? by.delta : 0),
    width: dragged.width,
    height: dragged.height,
  };
  const guides: SnapGuide[] = [];
  if (bx) guides.push(spanGuide('x', bx.line, snapped, refs));
  if (by) guides.push(spanGuide('y', by.line, snapped, refs));
  return { dx, dy, guides };
}

/**
 * 缩放吸附 —— 与 computeSnap 不同：被缩放矩形只**活动边**参与吸附，且吸附
 * 结果以活动边的位移表达（caller 据此调整矩形，再做最小尺寸 / 内容边界 clamp）。
 *
 * @param rect      当前缩放后的矩形（computeResize 已 clamp 过）。
 * @param hx        水平活动方向 -1=左边动 / 0=不动 / 1=右边动。
 * @param hy        垂直活动方向 -1=上边动 / 0=不动 / 1=下边动。
 * @param refs      参照矩形（非被缩放、非连线 / 建议的元素）。
 * @param threshold 吸附阈值（画布单位）。
 *
 * 返回值 `dx/dy` 是该轴上活动边应当被推到的位移（caller 负责调整矩形几何）。
 * `guides` 是绘制时的对齐参考线集合，跨度已覆盖吸附后的被缩放框与所有参照。
 */
export function snapResize(
  rect: RectLike,
  hx: -1 | 0 | 1,
  hy: -1 | 0 | 1,
  refs: ReadonlyArray<RectLike>,
  threshold: number,
): SnapResult {
  if (refs.length === 0 || (hx === 0 && hy === 0)) {
    return { dx: 0, dy: 0, guides: [] };
  }
  // 活动边的坐标：左边动 → start；右边动 → end；不动 → 不参与该轴吸附。
  const activeX: SnapEdge[] = hx === 1 ? ['end'] : hx === -1 ? ['start'] : [];
  const activeY: SnapEdge[] = hy === 1 ? ['end'] : hy === -1 ? ['start'] : [];
  const xLines = activeX.length > 0 ? activeLinePositions(rect, 'x', activeX) : [];
  const yLines = activeY.length > 0 ? activeLinePositions(rect, 'y', activeY) : [];
  const bx = xLines.length > 0 ? pickAxis(rect, 'x', refs, threshold, xLines) : null;
  const by = yLines.length > 0 ? pickAxis(rect, 'y', refs, threshold, yLines) : null;
  const dx = bx ? bx.delta : 0;
  const dy = by ? by.delta : 0;
  // 吸附后矩形（沿活动边伸缩） —— 用于参考线跨度。
  const snapped: RectLike = {
    x: hx === -1 ? rect.x + dx : rect.x,
    y: hy === -1 ? rect.y + dy : rect.y,
    width: hx === 1 ? rect.width + dx : hx === -1 ? rect.width - dx : rect.width,
    height: hy === 1 ? rect.height + dy : hy === -1 ? rect.height - dy : rect.height,
  };
  const guides: SnapGuide[] = [];
  if (bx) guides.push(spanGuide('x', bx.line, snapped, refs));
  if (by) guides.push(spanGuide('y', by.line, snapped, refs));
  return { dx, dy, guides };
}
