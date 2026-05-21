/**
 * 自研画布层 —— 视口模型与坐标换算（增量2：画布外壳）。
 *
 * 视口把「画布坐标」映射到「屏幕坐标」，公式：
 *     screen = (canvas + scroll) * zoom
 * 与 Excalidraw appState 的 scrollX/scrollY/zoom 同构 —— 过渡期 Board 自有视口
 * 与 Excalidraw 视口可双向互通（见 BoardCanvas）。增量3 拆掉 Excalidraw 后，
 * 这套视口就是画布唯一的视口真相源。
 */

/** 画布视口 —— 平移量（画布单位）+ 缩放。 */
export interface CanvasViewport {
  /** 画布平移 X。 */
  scrollX: number;
  /** 画布平移 Y。 */
  scrollY: number;
  /** 缩放系数。 */
  zoom: number;
}

/** 缩放范围（数据模型规格：0.1–5.0）。 */
export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 5;

/** 初始视口 —— 与 createBoardScene 的默认 viewport 对齐。 */
export const INITIAL_VIEWPORT: CanvasViewport = {
  scrollX: 0,
  scrollY: 0,
  zoom: 1,
};

/** 把缩放钳制到允许区间。 */
export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

/** 屏幕坐标 → 画布坐标（screen = (canvas + scroll) * zoom 的逆）。 */
export function screenToCanvas(
  vp: CanvasViewport,
  sx: number,
  sy: number,
): { x: number; y: number } {
  return { x: sx / vp.zoom - vp.scrollX, y: sy / vp.zoom - vp.scrollY };
}

/** 画布坐标 → 屏幕坐标。 */
export function canvasToScreen(
  vp: CanvasViewport,
  cx: number,
  cy: number,
): { x: number; y: number } {
  return { x: (cx + vp.scrollX) * vp.zoom, y: (cy + vp.scrollY) * vp.zoom };
}

/**
 * 平移视口 —— 给定屏幕像素位移（正值 = 内容朝该方向移动），换算到视口。
 * 屏幕位移除以 zoom 得到画布位移。
 */
export function panBy(
  vp: CanvasViewport,
  dxScreen: number,
  dyScreen: number,
): CanvasViewport {
  return {
    scrollX: vp.scrollX + dxScreen / vp.zoom,
    scrollY: vp.scrollY + dyScreen / vp.zoom,
    zoom: vp.zoom,
  };
}

/**
 * 以屏幕点 (sx,sy) 为锚定缩放 —— 锚点下的画布位置在缩放前后保持不动。
 *
 * 锚点画布坐标不变：sx/zoom' - scroll' = sx/zoom - scroll
 *   ⇒ scroll' = sx/zoom' - (sx/zoom - scroll)
 */
export function zoomAt(
  vp: CanvasViewport,
  nextZoomRaw: number,
  sx: number,
  sy: number,
): CanvasViewport {
  const zoom = clampZoom(nextZoomRaw);
  if (zoom === vp.zoom) return vp;
  return {
    scrollX: sx / zoom - (sx / vp.zoom - vp.scrollX),
    scrollY: sy / zoom - (sy / vp.zoom - vp.scrollY),
    zoom,
  };
}

/**
 * 两视口是否近似相等 —— 容差用于吸收浮点误差与 Excalidraw 回写抖动，
 * 避免 Board ⇄ Excalidraw 视口同步形成无意义的回环。
 */
export function viewportsEqual(a: CanvasViewport, b: CanvasViewport): boolean {
  return (
    Math.abs(a.scrollX - b.scrollX) < 0.01 &&
    Math.abs(a.scrollY - b.scrollY) < 0.01 &&
    Math.abs(a.zoom - b.zoom) < 0.0001
  );
}

/** fitToContent 关心的元素包围盒字段。 */
interface BoxLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 计算把全部元素装入视口的视口值 —— 导入 / 首次连接时聚焦到内容。
 *
 * 缩放上限 1（不放大小内容、保持原始比例），下限 ZOOM_MIN；内容居中。
 * 空场景或视口尺寸未知时回退到初始视口。
 */
export function fitToContent(
  elements: ReadonlyArray<BoxLike>,
  viewWidth: number,
  viewHeight: number,
  padding = 80,
): CanvasViewport {
  if (elements.length === 0 || viewWidth <= 0 || viewHeight <= 0) {
    return INITIAL_VIEWPORT;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const e of elements) {
    minX = Math.min(minX, e.x);
    minY = Math.min(minY, e.y);
    maxX = Math.max(maxX, e.x + e.width);
    maxY = Math.max(maxY, e.y + e.height);
  }
  const contentW = Math.max(1, maxX - minX);
  const contentH = Math.max(1, maxY - minY);
  const zoom = clampZoom(
    Math.min(
      (viewWidth - 2 * padding) / contentW,
      (viewHeight - 2 * padding) / contentH,
      1,
    ),
  );
  // 内容中心对齐视口中心：(center + scroll) * zoom = viewSize/2。
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  return {
    scrollX: viewWidth / 2 / zoom - centerX,
    scrollY: viewHeight / 2 / zoom - centerY,
    zoom,
  };
}
