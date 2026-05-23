/**
 * Agent 编辑锚点 helper —— PRD §7.4 / §8.2 焦点光标。
 *
 * 当 Agent 流式编辑一个元素时，浏览器要把它的「焦点光标」（带 jitter 的小
 * 箭头）钉到该元素内部正在编辑的具体位置（如 Markdown 第 N 行 / 字符位置）。
 * Agent 端必须 push `presence.targetOffset` 与此锚点一致 —— 否则光标会浮在
 * 元素中心，看着不像「在编辑这里」。
 *
 * 本 helper 把每种元素类型的「编辑锚点表」集中维护：CLI / MCP / web overlay
 * 三家共用，布局改动（padding / lineHeight / header 高度）只需要改一处。
 *
 * 返回值是元素本地坐标系（左上 = 0,0）的偏移；浏览器再加 `element.x/y` + 视口
 * 平移 + 缩放即可换到屏幕坐标。
 *
 * 注意：这里的数字与 `packages/web/src/overlay/overlay.css` 各 `.ov-*` 卡片
 * 的实际渲染对齐 —— 改 CSS 时记得同步这里。
 */
import type { Element } from './types.js';

/** 文本卡（`.ov-text`）布局常量 —— 与 overlay.css ov-text* 同步。 */
const TEXT_LAYOUT = {
  /** 标题栏已移除（透明文本卡），保留字段为 0 以便日后再加 header 时改一处。 */
  headerHeight: 0,
  /** `.ov-text__body` 内 padding-top（var(--space-2) = 8px） */
  bodyPaddingTop: 8,
  /** `.ov-text__body` 内 padding-left（var(--space-3) = 12px） */
  bodyPaddingLeft: 12,
  /** body font-size 13 × line-height 1.5 ≈ 20px；Markdown 列表项 / 段落基本一致 */
  lineHeight: 20,
  /** Markdown 列表项左缩进（roughly），让光标坐到「内容」位置而非项目符前 */
  textInsetX: 16,
} as const;

/** 区域卡（`.ov-region`）布局常量 —— 与 overlay.css ov-region__head 同步。 */
const REGION_LAYOUT = {
  /** 头部 padding：var(--space-2) var(--space-3) = 8px 12px */
  headerPaddingTop: 8,
  headerPaddingLeft: 12,
  /** 区域 label 字号 lg（约 18px）+ 描述 xs（约 12px），label baseline 锚点 */
  labelY: 16,
} as const;

/** 文件 / 文件夹卡（`.ov-file` / `.ov-folder`）—— 顶栏锚点。 */
const FILE_LAYOUT = {
  headerPaddingTop: 8,
  headerPaddingLeft: 12,
} as const;

/** 计算编辑锚点时可附加的上下文。 */
export interface EditAnchorContext {
  /**
   * Markdown 行号（0-indexed）—— 用于 text 元素流式编辑「正在写第 N 行」。
   * 行高按 `TEXT_LAYOUT.lineHeight`（20px）；不考虑 heading 行高差异（粗略
   * 但够「光标在这一行附近」的视觉语义）。
   */
  lineIndex?: number;
  /**
   * 字符列号（0-indexed）—— 字符级流式时按列偏移 x。每字符宽度按 8px
   * 粗估（CJK 文字宽度更接近 16px，但 jitter 范围远大于这个差，可接受）。
   */
  charIndex?: number;
}

/**
 * 计算元素的编辑锚点 —— 元素本地坐标的 (x, y) 偏移。
 *
 * @param el 任意 Element
 * @param ctx 流式编辑时可附 lineIndex / charIndex 微调
 * @returns 元素本地坐标偏移（左上 = 0,0）
 */
export function computeEditAnchor(
  el: Element,
  ctx: EditAnchorContext = {},
): { x: number; y: number } {
  switch (el.type) {
    case 'text': {
      const line = Math.max(0, ctx.lineIndex ?? 0);
      const col = Math.max(0, ctx.charIndex ?? 0);
      return {
        x: TEXT_LAYOUT.bodyPaddingLeft + TEXT_LAYOUT.textInsetX + col * 8,
        y:
          TEXT_LAYOUT.headerHeight +
          TEXT_LAYOUT.bodyPaddingTop +
          line * TEXT_LAYOUT.lineHeight +
          TEXT_LAYOUT.lineHeight / 2,
      };
    }
    case 'region':
      // 区域很大；锚点取头部 label 附近（左上角内侧）
      return {
        x: REGION_LAYOUT.headerPaddingLeft,
        y: REGION_LAYOUT.headerPaddingTop + REGION_LAYOUT.labelY,
      };
    case 'connector': {
      // 连线锚点 = 折线中点。waypoints / 线性插值时只能取整段中点近似。
      // 注意：connector 的 (start, end) 是相对元素 bbox 的局部坐标；自由端
      // 才有 point，绑定到元素的端点 point 为 undefined —— 此时用 bbox 角点兜底。
      const startPt: [number, number] = el.start.point ?? [0, 0];
      const endPt: [number, number] = el.end.point ?? [el.width, el.height];
      const pts: Array<[number, number]> =
        el.waypoints && el.waypoints.length > 0
          ? [startPt, ...el.waypoints, endPt]
          : [startPt, endPt];
      // 找折线总长一半的点
      let total = 0;
      const segs: { len: number; from: [number, number]; to: [number, number] }[] = [];
      for (let i = 0; i < pts.length - 1; i += 1) {
        const a = pts[i]!;
        const b = pts[i + 1]!;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        segs.push({ len, from: a, to: b });
        total += len;
      }
      let target = total / 2;
      for (const s of segs) {
        if (s.len >= target) {
          const t = s.len === 0 ? 0 : target / s.len;
          return {
            x: s.from[0] + (s.to[0] - s.from[0]) * t,
            y: s.from[1] + (s.to[1] - s.from[1]) * t,
          };
        }
        target -= s.len;
      }
      // 兜底：bbox 中心
      return { x: el.width / 2, y: el.height / 2 };
    }
    case 'shape':
    case 'image':
    case 'embed':
    case 'draw':
    case 'suggestion':
      // 这些元素的「编辑」语义弱（多为整体改样式 / 替换内容）—— 取几何中心
      return { x: el.width / 2, y: el.height / 2 };
    case 'file':
    case 'folder':
      // 文件 / 文件夹卡头部 —— label 区
      return {
        x: FILE_LAYOUT.headerPaddingLeft,
        y: FILE_LAYOUT.headerPaddingTop + 12,
      };
    default: {
      // 穷尽枚举防御性兜底
      const _exhaustive: never = el;
      void _exhaustive;
      return { x: 0, y: 0 };
    }
  }
}
