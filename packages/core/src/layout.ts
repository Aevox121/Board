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

// ── 文字度量（M5 L1 自适应高度）──────────────────────────────
// 默认字体（PRD §13 决策 13）：CJK 思源宋体（衬线，字面 em 方块）+ 拉丁
// Code New Roman（等宽）。两类度量可预测、与具体发行版几乎无关：
//   - CJK / 全角 → advance ≈ 1.0em
//   - 拉丁等宽   → advance ≈ 0.6em（Code New Roman 校准）
// 故无需 canvas，纯规则即贴近 web 实际渲染。

/** CJK / 全角字符的 advance（em）。 */
const CJK_ADVANCE_EM = 1.0;
/** 等宽拉丁 / 其它窄字符的 advance（em）。 */
const NARROW_ADVANCE_EM = 0.6;
/** 与 .cv-shape__label 一致的行高倍数。 */
const LABEL_LINE_HEIGHT = 1.3;

/** 判断字符是否按「全角 ≈ 1em」计（CJK 汉字 / 假名 / 谚文 / 全角符号等）。 */
function isWideChar(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x9fff) || // CJK 部首扩展 .. CJK 统一表意
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul 音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) || // 全角 ASCII / 标点
    (cp >= 0xffe0 && cp <= 0xffe6) || // 全角符号
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK 扩展 B+
  );
}

/**
 * 估算一段文字在给定宽度 / 字号下渲染所需高度（px）—— M5 L1 自适应高度。
 *
 * 纯规则折行：按 `CJK/全角 ≈ 1em、其余 ≈ 0.6em` 累加行宽，超过内容宽折行，
 * 显式 `\n` 强制断行；高度 = 行数 × lineHeight × fontSize + 上下 padding。
 * CJK 为主的 label 这等于精确（思源宋体 em 方块）。
 *
 * @param text       文字内容（含 `\n`）
 * @param widthPx    元素宽度（含 padding）
 * @param fontSizePx 字号
 * @param opts.padX/padY  单侧内边距（默认 10 / 6，对齐 .cv-shape__label）
 * @param opts.lineHeight 行高倍数（默认 1.3）
 * @param opts.minLines   最少行数（默认 1）
 */
export function measureLabelHeight(
  text: string,
  widthPx: number,
  fontSizePx: number,
  opts: {
    padX?: number;
    padY?: number;
    lineHeight?: number;
    minLines?: number;
  } = {},
): number {
  const padX = opts.padX ?? 10;
  const padY = opts.padY ?? 6;
  const lineHeight = opts.lineHeight ?? LABEL_LINE_HEIGHT;
  const contentWidth = Math.max(1, widthPx - padX * 2);
  const advWide = CJK_ADVANCE_EM * fontSizePx;
  const advNarrow = NARROW_ADVANCE_EM * fontSizePx;

  let totalLines = 0;
  for (const rawLine of text.split('\n')) {
    if (rawLine === '') {
      totalLines += 1;
      continue;
    }
    let cur = 0;
    let lineCount = 1;
    for (const ch of rawLine) {
      const adv = isWideChar(ch.codePointAt(0) ?? 0) ? advWide : advNarrow;
      if (cur + adv > contentWidth && cur > 0) {
        lineCount += 1;
        cur = adv;
      } else {
        cur += adv;
      }
    }
    totalLines += lineCount;
  }
  totalLines = Math.max(totalLines, opts.minLines ?? 1);
  return Math.ceil(totalLines * lineHeight * fontSizePx + padY * 2);
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

// ── 几何排版（M5 L3 board_arrange）────────────────────────────
// 把一批元素重排成整齐布局。与 L2「摆放仲裁」分工：L2 只保证不堆叠（找最近
// 空位塞行），L3 才负责语义对齐 / 成组（grid / row / column）。
// 纯几何、零依赖；调用方（CLI/MCP）拿结果原子批量改 x/y。

/** board_arrange 支持的几何布局。tree / 层级图归 board_add_flow（dagre）。 */
export type ArrangeLayout = 'grid' | 'row' | 'column';

/** 参与排版的元素：id + 当前矩形（尺寸用于算间距，位置用于推断默认锚点）。 */
export interface ArrangeItem extends Rect {
  id: string;
}

export interface ArrangeLayoutOptions {
  /** 元素间距，默认 LAYOUT.gap。 */
  gap?: number;
  /** grid 列数；省略 = 自动 ceil(sqrt(n))（接近正方形）。 */
  cols?: number;
  /** 整块左上角锚点；省略 = 取当前元素包围盒左上角（原地重排）。 */
  origin?: { x: number; y: number };
}

/**
 * 把一批元素排成 grid / row / column —— M5 L3。
 *
 * - **row**：左→右一行平铺，顶端对齐（同 y）。
 * - **column**：上→下一列堆叠，左端对齐（同 x）。
 * - **grid**：行主序填 `cols` 列；列宽取该列最宽元素、行高取该行最高元素
 *   （列对齐 + 行对齐，变长元素也不重叠）。
 *
 * 入参 `items` 的顺序即排布顺序。返回每个元素的新左上角坐标（不改尺寸）；
 * 结果内部互不重叠。**不做对「集合外」元素的二次避让**（设计 §3 L3：直接精确
 * 落，由调用方决定整块落点）—— 需放到空白处时调用方传 `origin`。
 */
export function arrangeElements(
  items: ArrangeItem[],
  layout: ArrangeLayout,
  opts: ArrangeLayoutOptions = {},
): Array<{ id: string; x: number; y: number }> {
  if (items.length === 0) return [];
  const gap = opts.gap ?? LAYOUT.gap;
  const origin = opts.origin ?? {
    x: Math.min(...items.map((i) => i.x)),
    y: Math.min(...items.map((i) => i.y)),
  };

  if (layout === 'row') {
    let x = origin.x;
    return items.map((it) => {
      const placed = { id: it.id, x, y: origin.y };
      x += it.width + gap;
      return placed;
    });
  }

  if (layout === 'column') {
    let y = origin.y;
    return items.map((it) => {
      const placed = { id: it.id, x: origin.x, y };
      y += it.height + gap;
      return placed;
    });
  }

  // grid：行主序，列宽 = 该列最宽、行高 = 该行最高。
  const n = items.length;
  const cols = Math.max(1, Math.floor(opts.cols ?? Math.ceil(Math.sqrt(n))));
  const rows = Math.ceil(n / cols);
  const at = (r: number, c: number): ArrangeItem | undefined => items[r * cols + c];

  const colWidths: number[] = [];
  for (let c = 0; c < cols; c++) {
    let w = 0;
    for (let r = 0; r < rows; r++) w = Math.max(w, at(r, c)?.width ?? 0);
    colWidths[c] = w;
  }
  const colX: number[] = [];
  let cx = origin.x;
  for (let c = 0; c < cols; c++) {
    colX[c] = cx;
    cx += colWidths[c]! + gap;
  }

  const out: Array<{ id: string; x: number; y: number }> = [];
  let ry = origin.y;
  for (let r = 0; r < rows; r++) {
    let rowHeight = 0;
    for (let c = 0; c < cols; c++) {
      const it = at(r, c);
      if (!it) continue;
      out.push({ id: it.id, x: colX[c]!, y: ry });
      rowHeight = Math.max(rowHeight, it.height);
    }
    ry += rowHeight + gap;
  }
  return out;
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
