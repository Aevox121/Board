/**
 * 自动排版算法 — 见 specs/数据模型规格.md §9。
 *
 * 当文件/文件夹经「直接改文件夹」或 CLI 无 --at 出现时，
 * 服务为其元素计算坐标（autoPlaced:true）。
 */
import type { ElementType, FileDisplayMode } from './types.js';

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Size {
  x: number;
  y: number;
}

/** 默认卡片尺寸（规格 §9.2） */
export const DEFAULT_SIZES = {
  fileIcon: { width: 120, height: 40 },
  fileCard: { width: 220, height: 120 },
  /** A4 纸比例（1:√2）—— markdown 文件预览渲染为固定纸张比例，超出做卡
   *  内翻页。width=320，height=320×√2≈452。 */
  filePreview: { width: 320, height: 452 },
  folder: { width: 200, height: 64 },
  region: { width: 480, height: 320 },
  text: { width: 280, height: 120 },
} as const;

/** 布局常量 */
export const LAYOUT = {
  gap: 24,
  regionHeaderHeight: 48,
  regionPadding: 16,
} as const;

/** 按元素类型给出默认尺寸。 */
export function defaultSizeFor(
  type: ElementType,
  fileDisplay?: FileDisplayMode,
): Size {
  switch (type) {
    case 'file':
    case 'image':
      if (fileDisplay === 'icon') return { ...DEFAULT_SIZES.fileIcon };
      if (fileDisplay === 'preview') return { ...DEFAULT_SIZES.filePreview };
      return { ...DEFAULT_SIZES.fileCard };
    case 'folder':
      return { ...DEFAULT_SIZES.folder };
    case 'region':
      return { ...DEFAULT_SIZES.region };
    case 'text':
      return { ...DEFAULT_SIZES.text };
    default:
      return { ...DEFAULT_SIZES.fileCard };
  }
}

/** 两矩形是否相交。 */
export function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/**
 * 在容器内按「网格流式布局」取下一空位（规格 §9.1 步骤 2）。
 *
 * @param container 容器矩形（region 边界，或收件区）
 * @param occupied  容器内已被「非 autoPlaced 元素」占据的矩形（碰撞规避）
 * @param size      待放元素尺寸
 */
export function nextSlot(
  container: Rect,
  occupied: Rect[],
  size: Size,
): { x: number; y: number } {
  const { gap, regionHeaderHeight, regionPadding } = LAYOUT;
  const left = container.x + regionPadding;
  const top = container.y + regionHeaderHeight + regionPadding;
  const innerWidth = container.width - regionPadding * 2;
  const cols = Math.max(1, Math.floor((innerWidth + gap) / (size.width + gap)));

  for (let row = 0; row < 10_000; row++) {
    for (let col = 0; col < cols; col++) {
      const candidate: Rect = {
        x: left + col * (size.width + gap),
        y: top + row * (size.height + gap),
        width: size.width,
        height: size.height,
      };
      if (!occupied.some((o) => overlaps(o, candidate))) {
        return { x: candidate.x, y: candidate.y };
      }
    }
  }
  // 理论不可达：容器无限高
  return { x: left, y: top };
}

/**
 * 锚点优先的防重叠落位（网格行优先外扩，M5 L2 摆放仲裁）。
 *
 * 语义：`at` 是「锚点偏好」而非硬坐标 —— 引擎优先放在 anchor，若与现有元素
 * 相交，则以 anchor 为起点按**网格行优先**（左→右排满一行宽度再换行下移）
 * 向外扫描，落到第一个不相交的格位。anchor 处空闲（常见情形：Agent 给了
 * 互不重叠的坐标）则原地返回，零位移。
 *
 * 与 `nextSlot` 区别：`nextSlot` 从容器左上角开始填格（适合"丢进收件区"语义）；
 * 本函数从 anchor 开始（适合"我想放这儿附近"语义），不依赖容器左上基准。
 *
 * @param occupied    需要避让的矩形（同层已有元素，尺寸应已 L1 自适应过）
 * @param size        待放元素尺寸
 * @param anchor      锚点（元素左上角偏好坐标）
 * @param opts.gap        元素间距，默认 LAYOUT.gap
 * @param opts.maxRowWidth 单行向右扫描的最大宽度（超出换行），默认 2400
 */
export function placeNearAnchor(
  occupied: Rect[],
  size: Size,
  anchor: { x: number; y: number },
  opts: { gap?: number; maxRowWidth?: number } = {},
): { x: number; y: number } {
  const gap = opts.gap ?? LAYOUT.gap;
  const maxRowWidth = opts.maxRowWidth ?? 2400;
  const free = (x: number, y: number): boolean => {
    const cand: Rect = { x, y, width: size.width, height: size.height };
    return !occupied.some((o) => overlaps(o, cand));
  };
  // anchor 本身空闲 —— 零位移返回（最常见路径）。
  if (free(anchor.x, anchor.y)) return { x: anchor.x, y: anchor.y };

  const stepX = size.width + gap;
  const stepY = size.height + gap;
  for (let row = 0; row < 10_000; row++) {
    const y = anchor.y + row * stepY;
    for (let col = 0; col < 10_000; col++) {
      const x = anchor.x + col * stepX;
      // 单行宽度护栏：超出 maxRowWidth 换到下一行（col 0 总要试一次）。
      if (col > 0 && x - anchor.x > maxRowWidth) break;
      if (free(x, y)) return { x, y };
    }
  }
  return { x: anchor.x, y: anchor.y };
}

/** 容器需要的最小高度（容纳全部子元素，规格 §9.1 步骤 3）。 */
export function requiredHeight(container: Rect, children: Rect[]): number {
  const bottom = children.reduce(
    (max, c) => Math.max(max, c.y + c.height),
    container.y,
  );
  return Math.max(
    container.height,
    bottom - container.y + LAYOUT.regionPadding,
  );
}

/**
 * 区域容纳其全部子元素所需的最小尺寸（含四周 padding）。
 *
 * 只由「子元素包围盒」算出，不带「不小于当前尺寸」语义 —— 调用方按需取
 * `max(当前尺寸, 本结果)`（reconcile 自动增长区域），或作为手动缩放的下限。
 *
 * @param region   区域矩形，取其 x/y 作为内容包围盒的左上基准
 * @param children 区域内子元素的矩形
 */
export function regionContentSize(region: Rect, children: Rect[]): Size {
  let right = region.x;
  let bottom = region.y;
  for (const c of children) {
    right = Math.max(right, c.x + c.width);
    bottom = Math.max(bottom, c.y + c.height);
  }
  return {
    width: Math.max(0, right - region.x) + LAYOUT.regionPadding,
    height: Math.max(0, bottom - region.y) + LAYOUT.regionPadding,
  };
}
