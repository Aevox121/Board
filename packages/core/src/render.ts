/**
 * 场景 → SVG 缩略图（M5 L4 board_render）—— 纯函数，零依赖。
 *
 * 用途：堆叠已由 L2 兜住，本层让 Agent「看得见」自己摆出来的版面 —— 把元素几何
 * 拼成一张近似缩略图（不追求手绘风/像素级还原，只为判断对齐 / 成组 / 留白 /
 * 出框 / 越界这类自由摆放问题）。调用方（CLI/MCP）可再光栅化成 PNG 喂给模型读图。
 *
 * 渲染策略：各元素按类型画成可区分的矩形 / 形状 + 截断 label；连线按两端元素
 * 中心连线并裁剪到盒子边缘 + 箭头。整图按 maxSize 等比缩放（viewBox 承担坐标变换）。
 */
import type { BoardScene, Element } from './types.js';

export interface RenderOptions {
  /** 只渲染某区域（含其直接子元素）。与 bbox 二选一。 */
  regionId?: string;
  /** 显式裁剪框（画布坐标）。与 regionId 二选一。 */
  bbox?: { x: number; y: number; width: number; height: number };
  /** 输出图最大边长（px），等比缩放，默认 1200。 */
  maxSize?: number;
  /** 内容包围盒四周留白（画布坐标），默认 48。 */
  padding?: number;
  /** 背景色，默认纸色 #faf9f5。 */
  background?: string;
}

export interface RenderResult {
  svg: string;
  /** 实际裁剪框（画布坐标）。 */
  bbox: { x: number; y: number; width: number; height: number };
  pixelWidth: number;
  pixelHeight: number;
  /** 实际画进图里的元素数。 */
  elementCount: number;
}

interface RectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

const DEFAULT_MAX_SIZE = 1200;
const DEFAULT_PADDING = 48;
const DEFAULT_BG = '#faf9f5';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 按近似字宽截断 label（CJK 按 1em、其余 0.6em 估）以适配盒宽。 */
function truncateLabel(text: string, widthPx: number, fontSize: number): string {
  const firstLine = text.split('\n')[0] ?? '';
  const budget = Math.max(1, widthPx - 12);
  let used = 0;
  let out = '';
  for (const ch of firstLine) {
    const cp = ch.codePointAt(0) ?? 0;
    const adv = (cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xff00 && cp <= 0xffef) || (cp >= 0xac00 && cp <= 0xd7a3)
      ? fontSize
      : fontSize * 0.6;
    if (used + adv > budget) return out + '…';
    out += ch;
    used += adv;
  }
  return out;
}

function isRenderableRect(e: Element): boolean {
  return e.type !== 'connector' && e.type !== 'draw';
}

/** 元素中心。 */
function center(r: RectLike): { x: number; y: number } {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** 从 rect 中心朝 (tx,ty) 方向求与 rect 边界的交点（连线裁剪到盒边）。 */
function edgePoint(r: RectLike, tx: number, ty: number): { x: number; y: number } {
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const hw = r.width / 2;
  const hh = r.height / 2;
  const scale = 1 / Math.max(Math.abs(dx) / hw || 0, Math.abs(dy) / hh || 0);
  return { x: cx + dx * scale, y: cy + dy * scale };
}

/** 类型 → 角标文字（让 Agent 一眼分清元素种类）。 */
const TYPE_TAG: Partial<Record<Element['type'], string>> = {
  file: 'FILE',
  folder: 'DIR',
  image: 'IMG',
  embed: 'EMBED',
  suggestion: 'SUGGEST',
  text: 'TXT',
};

/** 取元素的显示文字（label / markdown 首行 / path）。 */
function labelOf(e: Element): string {
  switch (e.type) {
    case 'shape':
      return e.label?.text ?? '';
    case 'text':
      return e.markdown ?? '';
    case 'region':
      return e.label ?? e.path ?? '';
    case 'file':
    case 'folder':
      return e.path?.split(/[/\\]/).pop() ?? e.path ?? '';
    case 'embed':
      return e.url ?? '';
    default:
      return '';
  }
}

export function renderSceneSvg(
  scene: BoardScene,
  opts: RenderOptions = {},
): RenderResult {
  const maxSize = opts.maxSize ?? DEFAULT_MAX_SIZE;
  const padding = opts.padding ?? DEFAULT_PADDING;
  const background = opts.background ?? DEFAULT_BG;

  const all = scene.elements;
  const byId = new Map(all.map((e) => [e.id, e]));

  // ── 选元素 ──
  let chosen: Element[];
  if (opts.regionId) {
    const region = byId.get(opts.regionId);
    chosen = all.filter(
      (e) => e.id === opts.regionId || e.parentId === opts.regionId,
    );
    if (region && !chosen.includes(region)) chosen.push(region);
  } else if (opts.bbox) {
    const b = opts.bbox;
    chosen = all.filter(
      (e) =>
        e.x < b.x + b.width &&
        e.x + e.width > b.x &&
        e.y < b.y + b.height &&
        e.y + e.height > b.y,
    );
  } else {
    chosen = all.slice();
  }

  const chosenIds = new Set(chosen.map((e) => e.id));
  const rectEls = chosen.filter(isRenderableRect);

  // ── 视图包围盒 ──
  let view: RectLike;
  if (opts.bbox) {
    view = opts.bbox;
  } else if (opts.regionId) {
    const region = byId.get(opts.regionId);
    view = region
      ? { x: region.x - padding, y: region.y - padding, width: region.width + padding * 2, height: region.height + padding * 2 }
      : { x: 0, y: 0, width: 800, height: 600 };
  } else if (rectEls.length > 0) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const e of rectEls) {
      minX = Math.min(minX, e.x);
      minY = Math.min(minY, e.y);
      maxX = Math.max(maxX, e.x + e.width);
      maxY = Math.max(maxY, e.y + e.height);
    }
    view = {
      x: minX - padding,
      y: minY - padding,
      width: maxX - minX + padding * 2,
      height: maxY - minY + padding * 2,
    };
  } else {
    view = { x: 0, y: 0, width: 800, height: 600 };
  }
  view.width = Math.max(1, view.width);
  view.height = Math.max(1, view.height);

  // ── 缩放（fit maxSize，限制上/下界）──
  const rawScale = maxSize / Math.max(view.width, view.height);
  const scale = Math.min(2, Math.max(0.02, rawScale));
  const pixelWidth = Math.max(1, Math.round(view.width * scale));
  const pixelHeight = Math.max(1, Math.round(view.height * scale));

  // ── 拼 SVG ──
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pixelWidth}" height="${pixelHeight}" ` +
      `viewBox="${view.x} ${view.y} ${view.width} ${view.height}">`,
  );
  parts.push(
    `<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
      `<path d="M0 0 L10 5 L0 10 z" fill="#6e6b62"/></marker></defs>`,
  );
  parts.push(`<rect x="${view.x}" y="${view.y}" width="${view.width}" height="${view.height}" fill="${background}"/>`);

  // 连线先画（垫在节点下面）。
  for (const e of chosen) {
    if (e.type !== 'connector') continue;
    const startEl = e.start.elementId ? byId.get(e.start.elementId) : undefined;
    const endEl = e.end.elementId ? byId.get(e.end.elementId) : undefined;
    if (!startEl || !endEl) continue; // 自由端点的连线略过（缩略图够用）
    const ca = center(startEl);
    const cb = center(endEl);
    const p1 = edgePoint(startEl, cb.x, cb.y);
    const p2 = edgePoint(endEl, ca.x, ca.y);
    parts.push(
      `<line x1="${p1.x.toFixed(1)}" y1="${p1.y.toFixed(1)}" x2="${p2.x.toFixed(1)}" y2="${p2.y.toFixed(1)}" ` +
        `stroke="#6e6b62" stroke-width="2" marker-end="url(#arr)"/>`,
    );
    if (e.label?.text) {
      const mx = (p1.x + p2.x) / 2;
      const my = (p1.y + p2.y) / 2;
      parts.push(
        `<text x="${mx.toFixed(1)}" y="${my.toFixed(1)}" font-size="14" fill="#6e6b62" ` +
          `text-anchor="middle" paint-order="stroke" stroke="${background}" stroke-width="3">${esc(e.label.text)}</text>`,
      );
    }
  }

  // 非连线元素按 z 排序后画。
  const drawOrder = chosen
    .filter((e) => e.type !== 'connector')
    .sort((a, b) => (a.z < b.z ? -1 : a.z > b.z ? 1 : 0));

  let drawn = chosen.filter((e) => e.type === 'connector' && chosenIds.has(e.id)).length;

  for (const e of drawOrder) {
    drawn++;
    const stroke = e.style?.strokeColor ?? '#1a1915';
    const bg = e.style?.backgroundColor;
    const fill = !bg || bg === 'transparent' ? 'none' : bg;
    const opacity = (e.style?.opacity ?? 100) / 100;
    const fontSize = e.style?.fontSize ?? 18;

    if (e.type === 'draw') continue; // 已在上面跳过（isRenderableRect=false 不入 drawOrder）

    // 底盒（各类型样式区分）。
    if (e.type === 'region') {
      parts.push(
        `<rect x="${e.x}" y="${e.y}" width="${e.width}" height="${e.height}" rx="8" ` +
          `fill="#f0eee6" fill-opacity="0.5" stroke="#d4d0c0" stroke-width="2" stroke-dasharray="8 6"/>`,
      );
    } else if (e.type === 'shape' && e.shape === 'ellipse') {
      parts.push(
        `<ellipse cx="${e.x + e.width / 2}" cy="${e.y + e.height / 2}" rx="${e.width / 2}" ry="${e.height / 2}" ` +
          `fill="${fill}" stroke="${stroke}" stroke-width="2" opacity="${opacity}"/>`,
      );
    } else if (e.type === 'shape' && e.shape === 'diamond') {
      const cx = e.x + e.width / 2;
      const cy = e.y + e.height / 2;
      parts.push(
        `<polygon points="${cx},${e.y} ${e.x + e.width},${cy} ${cx},${e.y + e.height} ${e.x},${cy}" ` +
          `fill="${fill}" stroke="${stroke}" stroke-width="2" opacity="${opacity}"/>`,
      );
    } else {
      // rectangle shape / text / file / folder / image / embed / suggestion
      const rectFill =
        e.type === 'shape' ? fill : e.type === 'suggestion' ? '#f6e6dd' : '#ffffff';
      const rectStroke =
        e.type === 'suggestion' ? '#d97757' : e.type === 'shape' ? stroke : '#d4d0c0';
      const dash = e.type === 'suggestion' || e.state === 'draft' ? ' stroke-dasharray="6 4"' : '';
      parts.push(
        `<rect x="${e.x}" y="${e.y}" width="${e.width}" height="${e.height}" rx="6" ` +
          `fill="${rectFill}" stroke="${rectStroke}" stroke-width="2" opacity="${opacity}"${dash}/>`,
      );
    }

    // 类型角标。
    const tag = TYPE_TAG[e.type];
    if (tag) {
      parts.push(
        `<text x="${e.x + 6}" y="${e.y + 16}" font-size="11" fill="#a8a498" font-family="monospace">${tag}</text>`,
      );
    }

    // 文字 label（居中截断）。region 的 label 放左上角。
    const raw = labelOf(e);
    if (raw) {
      const label = truncateLabel(raw, e.width, fontSize);
      if (e.type === 'region') {
        parts.push(
          `<text x="${e.x + 12}" y="${e.y + 26}" font-size="${fontSize}" fill="#6e6b62" font-weight="bold">${esc(label)}</text>`,
        );
      } else {
        parts.push(
          `<text x="${e.x + e.width / 2}" y="${e.y + e.height / 2 + fontSize / 3}" font-size="${fontSize}" ` +
            `fill="#1a1915" text-anchor="middle">${esc(label)}</text>`,
        );
      }
    }
  }

  // draw 笔迹（折线）。
  for (const e of chosen) {
    if (e.type !== 'draw') continue;
    drawn++;
    const pts = e.points.map((p) => `${(e.x + p[0]).toFixed(1)},${(e.y + p[1]).toFixed(1)}`).join(' ');
    if (pts) {
      parts.push(
        `<polyline points="${pts}" fill="none" stroke="${e.style?.strokeColor ?? '#1a1915'}" stroke-width="2"/>`,
      );
    }
  }

  parts.push('</svg>');

  return {
    svg: parts.join(''),
    bbox: { ...view },
    pixelWidth,
    pixelHeight,
    elementCount: drawn,
  };
}
