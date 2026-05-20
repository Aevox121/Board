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
  filePreview: { width: 320, height: 240 },
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
