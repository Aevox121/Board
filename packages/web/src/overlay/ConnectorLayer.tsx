/**
 * 连线层 —— 覆盖层内以 SVG 渲染 `connector` 元素。
 *
 * 连线脱离 Excalidraw、改由覆盖层绘制（M2 增量）。这样连线能连接**任意**
 * 元素 —— 图形 / 文件卡 / 文本卡 / 区域，并随端点元素移动 / 缩放实时跟随
 * （覆盖层在每次场景或拖拽状态变化时重渲染）。
 *
 * 路由：
 *  - 两端都绑定元素 → 端点贴各自矩形边缘（连线不戳进卡片内部，留 `EDGE_GAP`
 *    间隙），从根本上避免「连线压在图形上」。
 *  - 自由连线（用户用箭头工具画、无绑定）→ 按自身几何（meta.ex.points）画折线。
 *
 * 渲染：每条连线一个独立 `<svg>`，尺寸贴合该连线的包围盒并按画布坐标定位 ——
 * 不用 0×0 + overflow 的技巧（外层 svg 视口为 0 时浏览器会裁掉描边、连线画
 * 不出来）。端点元素的实时矩形由 `liveRects` 覆写（拖拽 / 缩放进行中的元素）。
 */
import { useMemo } from 'react';
import type { BoardScene, ConnectorElement, ArrowHead } from '@board/core';
import type { RectLike } from './util';

/** 端点贴边的间隙（画布单位）—— 箭头不与卡片边框糊在一起。 */
const EDGE_GAP = 6;
/** 箭头三角的长 / 半宽（画布单位）。 */
const ARROW_LEN = 13;
const ARROW_HALF = 5;
/** 点形端点的半径（画布单位）。 */
const DOT_R = 4;

/** 平面点。 */
interface Pt {
  x: number;
  y: number;
}

export interface ConnectorLayerProps {
  /** 内存中的白板场景。 */
  scene: BoardScene;
  /**
   * 实时矩形覆写 —— 正在拖拽 / 缩放的元素以此为准（id → 当前画布矩形）。
   * 其余元素直接读场景坐标。
   */
  liveRects: ReadonlyMap<string, RectLike>;
  /** 当前选中的连线 id —— 选中态在线下垫一道高亮光晕。 */
  selectedId?: string | null;
  /** 点击连线时回调其 id（用于选中该连线，配合 Delete 删除）。 */
  onSelect?: (id: string) => void;
  /**
   * 是否启用连线点选命中区。连线模式（箭头工具）下传 false —— 否则连线的
   * 透明命中描边会挡住「从连线上画起 / 画到」。
   */
  interactive?: boolean;
}

/** 一条连线渲染所需的几何 + 样式。 */
interface ConnGeom {
  id: string;
  /** 折线顶点（画布坐标），至少 2 个。 */
  pts: Pt[];
  stroke: string;
  strokeWidth: number;
  /** SVG stroke-dasharray；实线为 undefined。 */
  dash: string | undefined;
  opacity: number;
  startArrow: ArrowHead;
  endArrow: ArrowHead;
  label: string | null;
  /** 标签锚点（折线弧长中点）。 */
  labelAt: Pt;
}

const center = (r: RectLike): Pt => ({
  x: r.x + r.width / 2,
  y: r.y + r.height / 2,
});

const dist = (a: Pt, b: Pt): number => Math.hypot(b.x - a.x, b.y - a.y);

/**
 * 从矩形中心朝 (tx,ty) 方向射线与矩形边的交点 —— 连线的「贴边」落点。
 */
function edgePoint(r: RectLike, tx: number, ty: number): Pt {
  const c = center(r);
  const dx = tx - c.x;
  const dy = ty - c.y;
  if (dx === 0 && dy === 0) return c;
  const halfW = r.width / 2;
  const halfH = r.height / 2;
  const sx = dx !== 0 ? halfW / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? halfH / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { x: c.x + dx * s, y: c.y + dy * s };
}

/** strokeStyle → SVG dasharray（按线宽缩放，细线虚线段也细密）。 */
function dashOf(style: string, w: number): string | undefined {
  if (style === 'dashed') return `${w * 4} ${w * 3}`;
  if (style === 'dotted') return `${w} ${w * 2}`;
  return undefined;
}

/** 折线弧长中点 —— 连线标签的锚点。 */
function arcMidpoint(pts: Pt[]): Pt {
  let total = 0;
  for (let i = 1; i < pts.length; i += 1) {
    total += dist(pts[i - 1]!, pts[i]!);
  }
  let half = total / 2;
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const seg = dist(a, b);
    if (half <= seg) {
      const t = seg === 0 ? 0 : half / seg;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    half -= seg;
  }
  return pts[pts.length - 1]!;
}

/** 自由连线（无端点绑定）的折线顶点 —— 取 meta.ex.points，缺省则用包围盒对角。 */
function freePoints(conn: ConnectorElement): Pt[] {
  const ex = conn.meta?.['ex'];
  const raw =
    ex && typeof ex === 'object'
      ? (ex as { points?: unknown }).points
      : undefined;
  if (Array.isArray(raw) && raw.length >= 2) {
    return raw
      .filter(
        (p): p is [number, number] =>
          Array.isArray(p) &&
          typeof p[0] === 'number' &&
          typeof p[1] === 'number',
      )
      .map((p) => ({ x: conn.x + p[0], y: conn.y + p[1] }));
  }
  return [
    { x: conn.x, y: conn.y },
    { x: conn.x + conn.width, y: conn.y + conn.height },
  ];
}

/** 单位方向向量 from→to；零向量返回 (1,0)。 */
function unit(from: Pt, to: Pt): Pt {
  const len = dist(from, to);
  if (len === 0) return { x: 1, y: 0 };
  return { x: (to.x - from.x) / len, y: (to.y - from.y) / len };
}

/**
 * 箭头三角形的 SVG path —— tip 为尖端，dir 为指向 tip 的单位向量。
 */
function arrowPath(tip: Pt, dir: Pt): string {
  const bx = tip.x - dir.x * ARROW_LEN;
  const by = tip.y - dir.y * ARROW_LEN;
  const px = -dir.y * ARROW_HALF;
  const py = dir.x * ARROW_HALF;
  return `M ${tip.x} ${tip.y} L ${bx + px} ${by + py} L ${bx - px} ${by - py} Z`;
}

export function ConnectorLayer({
  scene,
  liveRects,
  selectedId,
  onSelect,
  interactive = true,
}: ConnectorLayerProps): JSX.Element | null {
  const geoms = useMemo<ConnGeom[]>(() => {
    // 按 id 去重（保留最后一次出现）—— 防御性兜底：即便上游意外塞进重复
    // connector，也不渲染重影、不触发 React 重复 key 警告。
    const seen = new Set<string>();
    const connectors: ConnectorElement[] = [];
    for (let i = scene.elements.length - 1; i >= 0; i -= 1) {
      const e = scene.elements[i];
      if (e && e.type === 'connector' && !seen.has(e.id)) {
        seen.add(e.id);
        connectors.push(e);
      }
    }
    if (connectors.length === 0) return [];

    const byId = new Map(scene.elements.map((e) => [e.id, e] as const));
    /** 取元素当前矩形 —— 优先实时覆写，否则读场景。 */
    const rectOf = (id: string): RectLike | null => {
      const live = liveRects.get(id);
      if (live) return live;
      const el = byId.get(id);
      return el
        ? { x: el.x, y: el.y, width: el.width, height: el.height }
        : null;
    };

    const out: ConnGeom[] = [];
    for (const conn of connectors) {
      const aRect = conn.start.elementId ? rectOf(conn.start.elementId) : null;
      const bRect = conn.end.elementId ? rectOf(conn.end.elementId) : null;

      let pts: Pt[];
      if (aRect || bRect) {
        // 至少一端绑定元素：绑定端贴该元素矩形边缘并随之移动 / 缩放跟随；
        // 自由端停在自身几何端点上。两端皆绑定即标准「贴边路由」。
        const free = freePoints(conn);
        const fa = free[0]!;
        const fb = free[free.length - 1]!;
        // 绑定端的朝向目标：对端中心（对端也绑定时）否则对端自由点。
        const towardA = bRect ? center(bRect) : fb;
        const towardB = aRect ? center(aRect) : fa;
        let p1 = aRect ? edgePoint(aRect, towardA.x, towardA.y) : fa;
        let p2 = bRect ? edgePoint(bRect, towardB.x, towardB.y) : fb;
        // 仅对绑定端回退 EDGE_GAP（自由端停在画的点上）。
        const len = dist(p1, p2);
        if (len > EDGE_GAP * 2 + 1) {
          const u = unit(p1, p2);
          if (aRect) p1 = { x: p1.x + u.x * EDGE_GAP, y: p1.y + u.y * EDGE_GAP };
          if (bRect) p2 = { x: p2.x - u.x * EDGE_GAP, y: p2.y - u.y * EDGE_GAP };
        }
        pts = [p1, p2];
      } else {
        // 两端都自由：按自身几何画折线。
        pts = freePoints(conn);
      }
      if (pts.length < 2) continue;

      const st = conn.style;
      out.push({
        id: conn.id,
        pts,
        stroke: st.strokeColor,
        strokeWidth: st.strokeWidth,
        dash: dashOf(st.strokeStyle, st.strokeWidth),
        opacity: st.opacity / 100,
        startArrow: conn.startArrow,
        endArrow: conn.endArrow,
        label: conn.label?.text ?? null,
        labelAt: arcMidpoint(pts),
      });
    }
    return out;
  }, [scene.elements, liveRects]);

  if (geoms.length === 0) return null;

  return (
    <>
      {geoms.map((g) => {
        // 每条连线一个独立 svg，尺寸贴合其包围盒（含箭头 / 线宽外扩余量）。
        const xs = g.pts.map((p) => p.x);
        const ys = g.pts.map((p) => p.y);
        const pad = ARROW_LEN + g.strokeWidth + 4;
        const minX = Math.min(...xs) - pad;
        const minY = Math.min(...ys) - pad;
        const w = Math.max(...xs) - Math.min(...xs) + pad * 2;
        const h = Math.max(...ys) - Math.min(...ys) + pad * 2;
        // 画布坐标 → svg 局部坐标。
        const loc = (p: Pt): Pt => ({ x: p.x - minX, y: p.y - minY });
        const lpts = g.pts.map(loc);
        const first = lpts[0]!;
        const last = lpts[lpts.length - 1]!;
        const endDir = unit(lpts[lpts.length - 2]!, last);
        const startDir = unit(lpts[1]!, first);
        const pointStr = lpts.map((p) => `${p.x},${p.y}`).join(' ');
        return (
          <svg
            key={g.id}
            className="ov-connector"
            data-connector-id={g.id}
            style={{ left: `${minX}px`, top: `${minY}px` }}
            width={w}
            height={h}
            aria-hidden="true"
          >
            <g opacity={g.opacity}>
              {/* 选中态：可见线之下垫一道半透明光晕。 */}
              {g.id === selectedId ? (
                <polyline
                  className="ov-connector-sel"
                  points={pointStr}
                  fill="none"
                  strokeWidth={g.strokeWidth + 8}
                />
              ) : null}
              <polyline
                className="ov-connector-line"
                points={pointStr}
                fill="none"
                stroke={g.stroke}
                strokeWidth={g.strokeWidth}
                strokeDasharray={g.dash}
              />
              {renderHead(g.endArrow, last, endDir, g.stroke, g.strokeWidth)}
              {renderHead(
                g.startArrow,
                first,
                startDir,
                g.stroke,
                g.strokeWidth,
              )}
              {/* 点选命中区 —— 透明粗描边，比可见线宽得多，方便点中细线。
                  连线模式下不渲染，避免挡住画箭头。 */}
              {interactive && onSelect ? (
                <polyline
                  className="ov-connector-hit"
                  points={pointStr}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={Math.max(g.strokeWidth + 10, 14)}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    onSelect(g.id);
                  }}
                />
              ) : null}
            </g>
          </svg>
        );
      })}
      {geoms
        .filter((g) => g.label)
        .map((g) => (
          <div
            key={`lbl-${g.id}`}
            className="ov-connector-label"
            style={{ left: `${g.labelAt.x}px`, top: `${g.labelAt.y}px` }}
          >
            {g.label}
          </div>
        ))}
    </>
  );
}

/** 渲染一个端点装饰（箭头三角 / 圆点 / 无）。 */
function renderHead(
  kind: ArrowHead,
  tip: Pt,
  dir: Pt,
  color: string,
  strokeWidth: number,
): JSX.Element | null {
  if (kind === 'none') return null;
  if (kind === 'dot') {
    return (
      <circle cx={tip.x} cy={tip.y} r={DOT_R + strokeWidth * 0.4} fill={color} />
    );
  }
  // arrow / triangle 同以填充三角形呈现。
  return <path d={arrowPath(tip, dir)} fill={color} />;
}
