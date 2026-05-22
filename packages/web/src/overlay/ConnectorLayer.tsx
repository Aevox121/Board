/**
 * 连线层 —— 覆盖层内以 SVG 渲染 `connector` 元素。
 *
 * 连线由覆盖层绘制，能连接**任意**元素 —— 图形 / 文件卡 / 文本卡 / 区域，并随
 * 端点元素移动 / 缩放实时跟随（覆盖层在每次场景或拖拽状态变化时重渲染）。
 *
 * 路由：
 *  - 两端都绑定元素 → 端点贴各自矩形边缘（连线不戳进卡片内部，留 `EDGE_GAP`
 *    间隙），从根本上避免「连线压在图形上」。
 *  - 自由连线（无绑定）→ 按自身几何（meta.ex.points）画折线。
 *
 * 端点重连（自研画布层）：选中连线后两端浮出圆形手柄，拖动手柄即把该端点
 * 重连到落点处的元素（落在空白处则变为自由端），由 `onEndpointCommit` 落定。
 *
 * 渲染：每条连线一个独立 `<svg>`，尺寸贴合该连线的包围盒并按画布坐标定位。
 * 端点元素的实时矩形由 `liveRects` 覆写（拖拽 / 缩放进行中的元素）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type {
  BoardScene,
  ConnectorElement,
  ConnectorRouting,
  ArrowHead,
  ShapeKind,
} from '@board/core';
import type { RectLike } from './util';

/** 端点贴边的间隙（画布单位）—— 箭头不与卡片边框糊在一起。 */
const EDGE_GAP = 6;
/** 箭头三角的长 / 半宽（画布单位）。 */
const ARROW_LEN = 13;
const ARROW_HALF = 5;
/** 点形端点的半径（画布单位）。 */
const DOT_R = 4;
/** 端点重连手柄的屏幕半径（像素）—— 按 zoom 反向缩放，保持恒定屏幕尺寸。 */
const HANDLE_R = 7;

/** 平面点。 */
interface Pt {
  x: number;
  y: number;
}

/** 端点拖拽的瞬时状态。 */
interface EndpointDrag {
  /** 被拖连线 id。 */
  connectorId: string;
  /** 被拖的是哪一端。 */
  which: 'start' | 'end';
  /** 捕获的指针 id。 */
  pointerId: number;
  /** 指针按下时的屏幕坐标。 */
  startScreenX: number;
  startScreenY: number;
  /** 被拖端点按下时的画布坐标。 */
  startCanvasX: number;
  startCanvasY: number;
  /** 另一端（不动）的画布坐标 —— 落定时用于重算几何。 */
  anchorX: number;
  anchorY: number;
  /** 被拖端点当前画布坐标。 */
  curX: number;
  curY: number;
}

export interface ConnectorLayerProps {
  /** 内存中的白板场景。 */
  scene: BoardScene;
  /**
   * 实时矩形覆写 —— 正在拖拽 / 缩放的元素以此为准（id → 当前画布矩形）。
   * 其余元素直接读场景坐标。
   */
  liveRects: ReadonlyMap<string, RectLike>;
  /**
   * 当前选区 id 集合 —— 选中的连线在线下垫高亮光晕；恰好单选该连线时两端
   * 浮出端点重连手柄。
   */
  selectedIds?: ReadonlySet<string>;
  /**
   * 点击连线时回调其 id —— additive（shift 点击）为 true 时切换其在多选中的
   * 去留，否则单选该连线。
   */
  onSelect?: (id: string, additive: boolean) => void;
  /**
   * 指针按下连线本体（非端点手柄、非 shift 点选）—— 由 OverlayLayer 发起整条
   * 连线（或其所在多选组）的拖拽。未提供时退化为仅选中。
   */
  onBodyDown?: (id: string, e: ReactPointerEvent<SVGElement>) => void;
  /**
   * 是否启用连线点选命中区。连线模式（箭头工具）下传 false —— 否则连线的
   * 透明命中描边会挡住「从连线上画起 / 画到」。
   */
  interactive?: boolean;
  /** 当前缩放 —— 端点拖拽把屏幕位移换算到画布、手柄按 zoom 反向缩放。 */
  zoom?: number;
  /**
   * 端点拖拽落定 —— 由 OverlayLayer 做命中测试、重绑端点、重算几何并落盘。
   * @param dropX/dropY     被拖端点的落点（画布坐标）
   * @param anchorX/anchorY 另一端的画布坐标
   */
  onEndpointCommit?: (
    connectorId: string,
    which: 'start' | 'end',
    dropX: number,
    dropY: number,
    anchorX: number,
    anchorY: number,
  ) => void;
  /**
   * 端点拖拽过程中的落点（画布坐标）—— 驱动「可连接元素」外包围高亮；
   * 传 null 表示拖拽结束、清除高亮。
   */
  onEndpointHover?: (pos: { x: number; y: number } | null) => void;
  /** 双击连线本体 —— 请求进入标签就地编辑（编辑态由 OverlayLayer 持有）。 */
  onLabelEdit?: (id: string) => void;
  /** 正在编辑标签的连线 id —— 该连线渲染 contentEditable 编辑区。 */
  editingLabelId?: string | null;
  /** 标签提交（失焦 / Enter）。 */
  onLabelCommit?: (id: string, text: string) => void;
  /** 标签编辑取消（Esc）。 */
  onLabelCancel?: () => void;
}

/** 一条连线渲染所需的几何 + 样式。 */
interface ConnGeom {
  id: string;
  /** 折线顶点（画布坐标），至少 2 个 —— 直线 2 点、折线 4 点、曲线 2 点。 */
  pts: Pt[];
  /** 路由方式 —— 决定按折线还是二次贝塞尔渲染。 */
  routing: ConnectorRouting;
  /** 曲线路由的控制点（画布坐标）；非曲线为 undefined。 */
  ctrl: Pt | undefined;
  stroke: string;
  strokeWidth: number;
  /** SVG stroke-dasharray；实线为 undefined。 */
  dash: string | undefined;
  opacity: number;
  /** 锁定态 —— 锁定连线不可拖拽 / 重连端点 / 编辑标签。 */
  locked: boolean;
  startArrow: ArrowHead;
  endArrow: ArrowHead;
  label: string | null;
  /** 标签锚点（折线弧长中点）。 */
  labelAt: Pt;
}

/**
 * 按路由方式把两端点 (p1,p2) 展开为渲染顶点。
 *  - straight：直连 [p1,p2]。
 *  - orthogonal：直角 Z 形折线 —— 主轴方向居中转折。
 *  - curved：仍是 [p1,p2]，弯曲由控制点在渲染时处理。
 */
function routePoints(p1: Pt, p2: Pt, routing: ConnectorRouting): Pt[] {
  if (routing !== 'orthogonal') return [p1, p2];
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  if (Math.abs(dx) < 1 || Math.abs(dy) < 1) return [p1, p2];
  if (Math.abs(dx) >= Math.abs(dy)) {
    const mx = (p1.x + p2.x) / 2;
    return [p1, { x: mx, y: p1.y }, { x: mx, y: p2.y }, p2];
  }
  const my = (p1.y + p2.y) / 2;
  return [p1, { x: p1.x, y: my }, { x: p2.x, y: my }, p2];
}

/** 曲线路由的二次贝塞尔控制点 —— 自 p1→p2 中点垂直弓起约 1/5 长度。 */
function curveControl(p1: Pt, p2: Pt): Pt {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy) || 1;
  const off = Math.min(len * 0.22, 140);
  return {
    x: (p1.x + p2.x) / 2 + (-dy / len) * off,
    y: (p1.y + p2.y) / 2 + (dx / len) * off,
  };
}

const center = (r: RectLike): Pt => ({
  x: r.x + r.width / 2,
  y: r.y + r.height / 2,
});

const dist = (a: Pt, b: Pt): number => Math.hypot(b.x - a.x, b.y - a.y);

/**
 * 从元素中心朝 (tx,ty) 方向的射线与元素**实际形状**外缘的交点 —— 连线的
 * 「贴边」落点。矩形按矩形边、椭圆按椭圆弧、菱形按菱形边求交，使连线端点
 * 贴合元素真实形状，而非隐形的包围盒。
 */
function edgePoint(r: RectLike, kind: ShapeKind, tx: number, ty: number): Pt {
  const c = center(r);
  const dx = tx - c.x;
  const dy = ty - c.y;
  if (dx === 0 && dy === 0) return c;
  const a = r.width / 2;
  const b = r.height / 2;
  let t: number;
  if (a <= 0 || b <= 0) {
    t = 0;
  } else if (kind === 'ellipse') {
    // 椭圆 (x/a)² + (y/b)² = 1 与射线求交。
    t = 1 / Math.hypot(dx / a, dy / b);
  } else if (kind === 'diamond') {
    // 菱形 |x/a| + |y/b| = 1 与射线求交。
    t = 1 / (Math.abs(dx) / a + Math.abs(dy) / b);
  } else {
    // 矩形：取先碰到的那条边。
    const sx = dx !== 0 ? a / Math.abs(dx) : Infinity;
    const sy = dy !== 0 ? b / Math.abs(dy) : Infinity;
    t = Math.min(sx, sy);
  }
  return { x: c.x + dx * t, y: c.y + dy * t };
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

/**
 * 自由连线（无端点绑定）的折线顶点 —— 取 meta.ex.points，缺省则用包围盒对角。
 * `ox`/`oy` 为连线原点：默认取 `conn.x/y`，连线本体被整体拖拽时由调用方传入
 * 实时原点，使自由端跟随拖拽。
 */
function freePoints(
  conn: ConnectorElement,
  ox: number = conn.x,
  oy: number = conn.y,
): Pt[] {
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
      .map((p) => ({ x: ox + p[0], y: oy + p[1] }));
  }
  return [
    { x: ox, y: oy },
    { x: ox + conn.width, y: oy + conn.height },
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
  selectedIds,
  onSelect,
  onBodyDown,
  interactive = true,
  zoom = 1,
  onEndpointCommit,
  onEndpointHover,
  onLabelEdit,
  editingLabelId,
  onLabelCommit,
  onLabelCancel,
}: ConnectorLayerProps): JSX.Element | null {
  // 端点拖拽瞬时状态；ref 镜像供指针回调读取最新值。
  const [epDrag, setEpDrag] = useState<EndpointDrag | null>(null);
  const epDragRef = useRef<EndpointDrag | null>(null);
  epDragRef.current = epDrag;

  const geoms = useMemo<ConnGeom[]>(() => {
    // 按 id 去重（保留最后一次出现）—— 防御性兜底。
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
    /** 取元素的形状 —— 图形按其 shape，其余（卡片 / 手绘等）按矩形。 */
    const kindOf = (id: string): ShapeKind => {
      const el = byId.get(id);
      return el && el.type === 'shape' ? el.shape : 'rectangle';
    };

    const out: ConnGeom[] = [];
    for (const conn of connectors) {
      // 正被拖拽的那一端视作自由端（忽略其绑定），停在光标处。
      const drag =
        epDrag && epDrag.connectorId === conn.id ? epDrag : null;
      const aBound = !!conn.start.elementId && drag?.which !== 'start';
      const bBound = !!conn.end.elementId && drag?.which !== 'end';
      const aRect = aBound ? rectOf(conn.start.elementId!) : null;
      const bRect = bBound ? rectOf(conn.end.elementId!) : null;

      // 连线本体正被整体拖拽时,liveRects 含其实时矩形 —— 用作自由端原点。
      const selfLive = liveRects.get(conn.id);
      const ox = selfLive ? selfLive.x : conn.x;
      const oy = selfLive ? selfLive.y : conn.y;

      // 两端的「自由位置」—— 拖拽端用光标位置，否则取 meta.ex.points。
      const free = freePoints(conn, ox, oy);
      let fa = free[0]!;
      let fb = free[free.length - 1]!;
      if (drag?.which === 'start') fa = { x: drag.curX, y: drag.curY };
      if (drag?.which === 'end') fb = { x: drag.curX, y: drag.curY };

      let pts: Pt[];
      if (aRect || bRect) {
        // 至少一端绑定元素：绑定端贴该元素矩形边缘并随之跟随；自由端停在
        // 自身位置。两端皆绑定即标准「贴边路由」。
        const towardA = bRect ? center(bRect) : fb;
        const towardB = aRect ? center(aRect) : fa;
        let p1 = aRect
          ? edgePoint(aRect, kindOf(conn.start.elementId!), towardA.x, towardA.y)
          : fa;
        let p2 = bRect
          ? edgePoint(bRect, kindOf(conn.end.elementId!), towardB.x, towardB.y)
          : fb;
        // 仅对绑定端回退 EDGE_GAP（自由端停在画的点上）。
        const len = dist(p1, p2);
        if (len > EDGE_GAP * 2 + 1) {
          const u = unit(p1, p2);
          if (aRect) p1 = { x: p1.x + u.x * EDGE_GAP, y: p1.y + u.y * EDGE_GAP };
          if (bRect) p2 = { x: p2.x - u.x * EDGE_GAP, y: p2.y - u.y * EDGE_GAP };
        }
        pts = [p1, p2];
      } else {
        // 两端都自由：用两端的自由位置。
        pts = [fa, fb];
      }
      if (pts.length < 2) continue;

      // 路由展开 —— 折线插入直角转折点，曲线另算控制点。
      const e1 = pts[0]!;
      const e2 = pts[pts.length - 1]!;
      const routePts = routePoints(e1, e2, conn.routing);
      const ctrl =
        conn.routing === 'curved' ? curveControl(e1, e2) : undefined;

      const st = conn.style;
      out.push({
        id: conn.id,
        pts: routePts,
        routing: conn.routing,
        ctrl,
        stroke: st.strokeColor,
        strokeWidth: st.strokeWidth,
        dash: dashOf(st.strokeStyle, st.strokeWidth),
        opacity: st.opacity / 100,
        locked: conn.locked,
        startArrow: conn.startArrow,
        endArrow: conn.endArrow,
        label: conn.label?.text ?? null,
        // 曲线标签锚点取贝塞尔 t=0.5 处（非控制点）。
        labelAt: ctrl
          ? {
              x: 0.25 * e1.x + 0.5 * ctrl.x + 0.25 * e2.x,
              y: 0.25 * e1.y + 0.5 * ctrl.y + 0.25 * e2.y,
            }
          : arcMidpoint(routePts),
      });
    }
    return out;
  }, [scene.elements, liveRects, epDrag]);

  // ── 端点拖拽指针处理 ─────────────────────────────────────────
  // 移动 / 抬起监听挂在 window 上（不靠 SVG 元素的 setPointerCapture ——
  // 后者在 SVG 子元素上不可靠）。用 ref 让回调读到最新 zoom / 提交回调。
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const commitRef = useRef(onEndpointCommit);
  commitRef.current = onEndpointCommit;
  const hoverRef = useRef(onEndpointHover);
  hoverRef.current = onEndpointHover;

  const onWinMove = useCallback((e: PointerEvent): void => {
    const d = epDragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const dx = (e.clientX - d.startScreenX) / zoomRef.current;
    const dy = (e.clientY - d.startScreenY) / zoomRef.current;
    const next: EndpointDrag = {
      ...d,
      curX: d.startCanvasX + dx,
      curY: d.startCanvasY + dy,
    };
    epDragRef.current = next;
    setEpDrag(next);
    // 实时上报落点 —— 驱动「可连接元素」外包围高亮。
    hoverRef.current?.({ x: next.curX, y: next.curY });
  }, []);
  const onWinUp = useCallback(
    (e: PointerEvent): void => {
      const d = epDragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      window.removeEventListener('pointermove', onWinMove);
      window.removeEventListener('pointerup', onWinUp);
      window.removeEventListener('pointercancel', onWinUp);
      epDragRef.current = null;
      setEpDrag(null);
      hoverRef.current?.(null); // 清除外包围高亮
      commitRef.current?.(
        d.connectorId,
        d.which,
        d.curX,
        d.curY,
        d.anchorX,
        d.anchorY,
      );
    },
    [onWinMove],
  );
  // 卸载时兜底移除 window 监听。
  useEffect(
    () => () => {
      window.removeEventListener('pointermove', onWinMove);
      window.removeEventListener('pointerup', onWinUp);
      window.removeEventListener('pointercancel', onWinUp);
    },
    [onWinMove, onWinUp],
  );

  const onHandleDown = (
    e: ReactPointerEvent<SVGCircleElement>,
    g: ConnGeom,
    which: 'start' | 'end',
  ): void => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const ep = which === 'start' ? g.pts[0]! : g.pts[g.pts.length - 1]!;
    const other = which === 'start' ? g.pts[g.pts.length - 1]! : g.pts[0]!;
    const d: EndpointDrag = {
      connectorId: g.id,
      which,
      pointerId: e.pointerId,
      startScreenX: e.clientX,
      startScreenY: e.clientY,
      startCanvasX: ep.x,
      startCanvasY: ep.y,
      anchorX: other.x,
      anchorY: other.y,
      curX: ep.x,
      curY: ep.y,
    };
    epDragRef.current = d;
    setEpDrag(d);
    window.addEventListener('pointermove', onWinMove);
    window.addEventListener('pointerup', onWinUp);
    window.addEventListener('pointercancel', onWinUp);
  };

  if (geoms.length === 0) return null;

  return (
    <>
      {geoms.map((g) => {
        // 每条连线一个独立 svg，尺寸贴合其包围盒（含箭头 / 线宽外扩余量）。
        // 包围盒含曲线控制点 —— 否则弓起部分会被 svg 裁掉。
        const bpts = g.ctrl ? [...g.pts, g.ctrl] : g.pts;
        const xs = bpts.map((p) => p.x);
        const ys = bpts.map((p) => p.y);
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
        // 路径数据 + 端点切线方向 —— 曲线走二次贝塞尔，其余走折线。
        let pathD: string;
        let endDir: Pt;
        let startDir: Pt;
        if (g.routing === 'curved' && g.ctrl) {
          const c = loc(g.ctrl);
          pathD = `M ${first.x} ${first.y} Q ${c.x} ${c.y} ${last.x} ${last.y}`;
          endDir = unit(c, last);
          startDir = unit(c, first);
        } else {
          pathD = 'M ' + lpts.map((p) => `${p.x} ${p.y}`).join(' L ');
          endDir = unit(lpts[lpts.length - 2]!, last);
          startDir = unit(lpts[1]!, first);
        }
        const isSelected = !!selectedIds?.has(g.id);
        // 端点重连手柄 —— 仅恰好单选该连线时出现（多选不重连、锁定不重连）。
        const showHandles =
          isSelected &&
          selectedIds?.size === 1 &&
          !!onEndpointCommit &&
          !g.locked;
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
              {isSelected ? (
                <path
                  className="ov-connector-sel"
                  d={pathD}
                  fill="none"
                  strokeWidth={g.strokeWidth + 8}
                />
              ) : null}
              <path
                className="ov-connector-line"
                d={pathD}
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
                  连线模式下不渲染，避免挡住画箭头。双击进入标签编辑。 */}
              {interactive && onSelect ? (
                <path
                  className="ov-connector-hit"
                  d={pathD}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={Math.max(g.strokeWidth + 10, 14)}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    if (g.locked) {
                      // 锁定连线 —— 仅可点选（以便解锁），不拖拽。
                      onSelect(g.id, e.shiftKey);
                    } else if (e.shiftKey) {
                      // shift 点选 —— 切换该连线在多选中的去留，不拖拽。
                      onSelect(g.id, true);
                    } else if (onBodyDown) {
                      // 普通按下 —— 发起整条连线（或所在多选组）的拖拽。
                      onBodyDown(g.id, e);
                    } else {
                      onSelect(g.id, false);
                    }
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    if (!g.locked) onLabelEdit?.(g.id);
                  }}
                />
              ) : null}
            </g>
            {/* 端点重连手柄 —— 选中态两端各一个圆，可拖拽改连接对象。
                半径按 zoom 反向缩放，保持恒定屏幕尺寸。 */}
            {showHandles ? (
              <>
                <circle
                  className="ov-conn-handle"
                  cx={first.x}
                  cy={first.y}
                  r={HANDLE_R / zoom}
                  strokeWidth={1.6 / zoom}
                  onPointerDown={(e) => onHandleDown(e, g, 'start')}
                />
                <circle
                  className="ov-conn-handle"
                  cx={last.x}
                  cy={last.y}
                  r={HANDLE_R / zoom}
                  strokeWidth={1.6 / zoom}
                  onPointerDown={(e) => onHandleDown(e, g, 'end')}
                />
              </>
            ) : null}
          </svg>
        );
      })}
      {geoms
        .filter((g) => g.label || g.id === editingLabelId)
        .map((g) =>
          g.id === editingLabelId ? (
            <ConnLabelEditor
              key={`lbl-${g.id}`}
              id={g.id}
              text={g.label ?? ''}
              at={g.labelAt}
              onCommit={onLabelCommit}
              onCancel={onLabelCancel}
            />
          ) : (
            <div
              key={`lbl-${g.id}`}
              className="ov-connector-label"
              style={{ left: `${g.labelAt.x}px`, top: `${g.labelAt.y}px` }}
            >
              {g.label}
            </div>
          ),
        )}
    </>
  );
}

/**
 * 连线标签就地编辑区 —— 双击连线进入。contentEditable 复用标签样式，
 * 失焦 / Enter / Ctrl+Enter 提交，Esc 取消；清空则标签置空。
 */
function ConnLabelEditor({
  id,
  text,
  at,
  onCommit,
  onCancel,
}: {
  id: string;
  text: string;
  at: Pt;
  onCommit?: (id: string, text: string) => void;
  onCancel?: () => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.textContent = text;
    node.focus();
    const range = document.createRange();
    range.selectNodeContents(node);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    // 仅进入时跑一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commit = (): void => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCommit?.(id, ref.current?.textContent ?? '');
  };
  const cancel = (): void => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCancel?.();
  };

  return (
    <div
      ref={ref}
      className="ov-connector-label ov-connector-label--edit"
      contentEditable
      suppressContentEditableWarning
      style={{ left: `${at.x}px`, top: `${at.y}px` }}
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          cancel();
        } else if (e.key === 'Enter') {
          // 连线标签通常单行 —— Enter 直接提交。
          e.preventDefault();
          e.stopPropagation();
          commit();
        }
      }}
    />
  );
}

/** 渲染一个端点装饰（开口箭头 / 实心三角 / 圆点 / 无）。 */
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
  if (kind === 'arrow') {
    // 开口箭头 —— 两道描边线（V 形），不填充。
    const bx = tip.x - dir.x * ARROW_LEN;
    const by = tip.y - dir.y * ARROW_LEN;
    const px = -dir.y * ARROW_HALF;
    const py = dir.x * ARROW_HALF;
    return (
      <path
        d={`M ${bx + px} ${by + py} L ${tip.x} ${tip.y} L ${bx - px} ${by - py}`}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    );
  }
  // triangle —— 实心三角形。
  return <path d={arrowPath(tip, dir)} fill={color} />;
}
