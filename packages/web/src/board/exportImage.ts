/**
 * 白板导出为 PNG / SVG 图片。
 *
 * 产出「真·SVG」（不含 `<foreignObject>`）—— 浏览器把含 foreignObject 的
 * SVG 画到 canvas 会污染画布、无法导出 PNG，故：
 *  - 图形 / 连线 / 手绘 已是原生 SVG —— 直接从实时 DOM 抓取其矢量节点，
 *    定位到画布坐标，导出即像素级精确。
 *  - 文件 / 文件夹 / 区域 / 文本等 HTML 卡片 —— 渲染为带标签的矩形（简化，
 *    保留位置 / 配色 / 名称，足以表达白板结构）。
 *
 * SVG 可在任意工具打开；PNG 由该 SVG 经 `<img>` 栅格化到 canvas（无
 * foreignObject 即不污染画布）。无第三方依赖。
 */
import type { BoardScene, Element } from '@board/core';

const SVGNS = 'http://www.w3.org/2000/svg';
/** 内容包围盒外扩留白（画布单位）。 */
const PADDING = 48;

/** 触发浏览器下载一个 Blob。 */
function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** 读取一个 CSS 变量的计算值（用于把字体栈固化进导出 SVG）。 */
function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

/** 计算场景内容包围盒（画布坐标，已含留白）。空场景返回 null。 */
function contentBox(
  scene: BoardScene,
): { x: number; y: number; w: number; h: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const e of scene.elements) {
    minX = Math.min(minX, e.x);
    minY = Math.min(minY, e.y);
    maxX = Math.max(maxX, e.x + e.width);
    maxY = Math.max(maxY, e.y + e.height);
  }
  if (!Number.isFinite(minX)) return null;
  return {
    x: minX - PADDING,
    y: minY - PADDING,
    w: Math.ceil(maxX - minX + PADDING * 2),
    h: Math.ceil(maxY - minY + PADDING * 2),
  };
}

/** 新建一个 SVG 命名空间元素并批量设属性。 */
function svgNode(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** 居中多行文字 —— 在 (cx,cy) 处放一个分行 `<text>`。 */
function centeredText(
  text: string,
  cx: number,
  cy: number,
  opts: { fontSize: number; fontFamily: string; color: string },
): SVGElement {
  const lines = text.split('\n');
  const lh = opts.fontSize * 1.3;
  const t = svgNode('text', {
    x: cx,
    y: cy - ((lines.length - 1) * lh) / 2,
    'text-anchor': 'middle',
    'dominant-baseline': 'central',
    'font-family': opts.fontFamily,
    'font-size': opts.fontSize,
    fill: opts.color,
  });
  lines.forEach((line, i) => {
    const span = svgNode('tspan', { x: cx, dy: i === 0 ? 0 : lh });
    span.textContent = line;
    t.appendChild(span);
  });
  return t;
}

/** 元素旋转 transform（弧度 → degrees，绕元素中心）。 */
function rotateAttr(el: Element): string {
  const deg = ((el.angle || 0) * 180) / Math.PI;
  if (!deg) return '';
  return ` rotate(${deg.toFixed(3)} ${el.width / 2} ${el.height / 2})`;
}

/** 图形 / 手绘 —— 抓取实时 DOM 里已渲染好的原生 SVG 矢量节点。 */
function vectorG(el: Element, innerSelector: string): SVGElement | null {
  const slot = document.querySelector(`[data-element-id="${el.id}"]`);
  const inner = slot?.querySelector(innerSelector);
  if (!inner) return null;
  const g = svgNode('g', {
    transform: `translate(${el.x} ${el.y})${rotateAttr(el)}`,
    opacity: el.style.opacity / 100,
  });
  for (const child of Array.from(inner.childNodes)) {
    g.appendChild(child.cloneNode(true));
  }
  return g;
}

/** 连线 —— 抓取实时 DOM 的 `.ov-connector` SVG（已含折线 / 箭头）。 */
function connectorG(el: Element): SVGElement | null {
  const svg = document.querySelector<SVGSVGElement>(
    `[data-connector-id="${el.id}"]`,
  );
  if (!svg) return null;
  const left = parseFloat(svg.style.left) || 0;
  const top = parseFloat(svg.style.top) || 0;
  const g = svgNode('g', { transform: `translate(${left} ${top})` });
  for (const child of Array.from(svg.childNodes)) {
    // 跳过命中区 / 端点手柄（交互装饰，不入导出）。
    if (
      child instanceof SVGElement &&
      (child.classList.contains('ov-connector-hit') ||
        child.classList.contains('ov-conn-handle'))
    ) {
      continue;
    }
    g.appendChild(child.cloneNode(true));
  }
  return g;
}

/** 卡片（文件 / 文件夹 / 区域 / 文本等）—— 渲染为带标签的矩形。 */
function cardG(el: Element, handFont: string): SVGElement {
  const g = svgNode('g', {
    transform: `translate(${el.x} ${el.y})${rotateAttr(el)}`,
    opacity: el.style.opacity / 100,
  });
  const bg = el.style.backgroundColor;
  const fill = bg && bg !== 'transparent' ? bg : '#ffffff';
  g.appendChild(
    svgNode('rect', {
      width: el.width,
      height: el.height,
      rx: 8,
      fill,
      stroke: el.style.strokeColor || '#1e1e1e',
      'stroke-width': Math.max(1, el.style.strokeWidth),
    }),
  );
  // 卡片主标题。
  let label = '';
  if (el.type === 'region') label = el.label || '区域';
  else if (el.type === 'folder') label = el.path.split('/').pop() || '文件夹';
  else if (el.type === 'file') label = el.path.split('/').pop() || '文件';
  else if (el.type === 'text') label = el.markdown.slice(0, 120);
  else if (el.type === 'suggestion') label = '建议';
  if (label) {
    g.appendChild(
      centeredText(label, el.width / 2, el.height / 2, {
        fontSize: el.style.fontSize || 16,
        fontFamily: handFont,
        color: el.style.strokeColor || '#1e1e1e',
      }),
    );
  }
  return g;
}

/** 构建承载整块白板的真·SVG。 */
function buildSvg(scene: BoardScene): { svg: string; w: number; h: number } {
  const box = contentBox(scene);
  if (!box) throw new Error('白板为空，无可导出内容');
  const { x, y, w, h } = box;

  const handFont = cssVar('--font-hand', 'KaiTi, cursive');
  const cream = cssVar('--c-cream', '#f4efe4');

  const svgEl = svgNode('svg', {
    xmlns: SVGNS,
    width: w,
    height: h,
    // viewBox 用画布坐标 —— 各元素直接按 element.x/y 定位，无需平移。
    viewBox: `${x} ${y} ${w} ${h}`,
  });
  svgEl.appendChild(
    svgNode('rect', { x, y, width: w, height: h, fill: cream }),
  );

  // 按 z 升序渲染（与画布堆叠一致）。
  const ordered = [...scene.elements].sort((a, b) =>
    a.z < b.z ? -1 : a.z > b.z ? 1 : 0,
  );
  for (const el of ordered) {
    let node: SVGElement | null = null;
    if (el.type === 'connector') node = connectorG(el);
    else if (el.type === 'shape') {
      node = vectorG(el, '.cv-shape__svg');
      // 图形标签（若有）。
      if (node && el.label?.text) {
        node.appendChild(
          centeredText(el.label.text, el.width / 2, el.height / 2, {
            fontSize: el.label.fontSize ?? el.style.fontSize ?? 20,
            fontFamily: handFont,
            color: el.style.strokeColor,
          }),
        );
      }
    } else if (el.type === 'draw') {
      node = vectorG(el, '.cv-draw');
    } else if (el.type !== 'image' && el.type !== 'embed') {
      node = cardG(el, handFont);
    }
    if (node) svgEl.appendChild(node);
  }

  const svg = new XMLSerializer().serializeToString(svgEl);
  return { svg, w, h };
}

/** SVG 字符串 → PNG Blob（经 `<img>` 栅格化到 canvas；真·SVG 不污染画布）。 */
function svgToPng(svg: string, w: number, h: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    // 大图降采样，避免超出 canvas 尺寸上限。
    const scale = Math.max(w, h) > 2200 ? 1 : 2;
    const url = URL.createObjectURL(
      new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }),
    );
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('无法创建 canvas 上下文'));
        return;
      }
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('PNG 编码失败'))),
        'image/png',
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('SVG 渲染失败'));
    };
    img.src = url;
  });
}

/**
 * 把当前白板导出为图片并触发下载。
 * @param scene    当前场景。
 * @param format   `'png'` 或 `'svg'`。
 * @param fileName 文件名（不含扩展名）。
 */
export async function exportBoardImage(
  scene: BoardScene,
  format: 'png' | 'svg',
  fileName: string,
): Promise<void> {
  const { svg, w, h } = buildSvg(scene);
  if (format === 'svg') {
    download(
      new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }),
      `${fileName}.svg`,
    );
    return;
  }
  download(await svgToPng(svg, w, h), `${fileName}.png`);
}
