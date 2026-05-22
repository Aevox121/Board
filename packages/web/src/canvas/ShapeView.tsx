/**
 * 图形渲染 —— 把一个 ShapeElement（矩形 / 椭圆 / 菱形）渲染为手绘风 SVG。
 *
 * 自研画布层 增量1：用 roughjs（Excalidraw 内部同款手绘几何库）直接生成
 * SVG，不再经 Excalidraw。用 `rough.svg()` 命令式生成 `<g>` 节点 —— roughjs
 * 自己处理描边 / 填充 / 线型，最稳妥。
 *
 * seed 由元素 id 派生并固定 —— 同一图形每次渲染的手绘抖动一致，不会跳动。
 */
import { useEffect, useRef, type CSSProperties } from 'react';
import rough from 'roughjs';
import type { Options } from 'roughjs/bin/core';
import type { ShapeElement, Style } from '@board/core';
import './canvas.css';

/** 由元素 id 派生稳定数值 seed（djb2 变体），使手绘抖动每次一致。 */
function seedOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return (Math.abs(h) % 2147483646) + 1;
}

/** core 统一样式 → roughjs 选项。 */
function roughOptions(style: Style, id: string): Options {
  const opts: Options = {
    seed: seedOf(id),
    stroke: style.strokeColor,
    strokeWidth: style.strokeWidth,
    roughness: style.roughness,
  };
  if (style.backgroundColor && style.backgroundColor !== 'transparent') {
    opts.fill = style.backgroundColor;
    opts.fillStyle = style.fillStyle === 'none' ? 'solid' : style.fillStyle;
  }
  if (style.strokeStyle === 'dashed') opts.strokeLineDash = [10, 8];
  else if (style.strokeStyle === 'dotted') {
    opts.strokeLineDash = [2, 7];
    opts.strokeLineDashOffset = 0;
  }
  return opts;
}

/** fontFamily 枚举 → CSS 字体栈。 */
function fontStack(family: Style['fontFamily']): string {
  if (family === 'code') return 'var(--font-code, ui-monospace, monospace)';
  if (family === 'normal') return 'var(--font-ui, system-ui, sans-serif)';
  return 'var(--font-hand, "Comic Sans MS", cursive)';
}

/**
 * 圆角矩形的 SVG path（局部坐标，左上角为原点）—— roughjs `rs.rectangle`
 * 不支持圆角，故 cornerRadius>0 时改走 `rs.path`。半径夹到不超过半边长。
 */
function roundedRectPath(w: number, h: number, radius: number): string {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  return [
    `M ${r} 0`,
    `H ${w - r}`,
    `A ${r} ${r} 0 0 1 ${w} ${r}`,
    `V ${h - r}`,
    `A ${r} ${r} 0 0 1 ${w - r} ${h}`,
    `H ${r}`,
    `A ${r} ${r} 0 0 1 0 ${h - r}`,
    `V ${r}`,
    `A ${r} ${r} 0 0 1 ${r} 0`,
    'Z',
  ].join(' ');
}

export interface ShapeViewProps {
  element: ShapeElement;
  /**
   * 是否处于标签就地编辑态 —— 由 OverlayLayer 控制（双击经指针捕获落在
   * 卡槽上，故编辑态提到上层）。缺省（如创建预览）即不可编辑。
   */
  editingLabel?: boolean;
  /** 标签提交（失焦 / Ctrl+Enter）—— 由 OverlayLayer 写回场景。 */
  onLabelCommit?: (text: string) => void;
  /** 标签编辑取消（Esc）—— 由 OverlayLayer 退出编辑态、不写回。 */
  onLabelCancel?: () => void;
}

/**
 * 把一个 ShapeElement 渲染为手绘风 SVG + 居中标签（局部坐标 0..w / 0..h）。
 * 调用方负责把它定位到画布坐标 (element.x, element.y)。
 *
 * 标签就地编辑：双击图形（由 OverlayLayer 卡槽捕获）进入编辑 —— 渲染
 * contentEditable（复用居中标签样式），失焦 / Ctrl+Enter 提交、Esc 取消；
 * 清空则标签置空。
 */
export function ShapeView({
  element,
  editingLabel = false,
  onLabelCommit,
  onLabelCancel,
}: ShapeViewProps): JSX.Element {
  const { width: w, height: h, shape, style, label } = element;
  const svgRef = useRef<SVGSVGElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  // 防重复收尾 —— commit / cancel 后 onBlur 可能再触发一次。
  const finishedRef = useRef(false);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    svg.replaceChildren();
    const rs = rough.svg(svg);
    const opts = roughOptions(style, element.id);
    let node: SVGGElement;
    if (shape === 'ellipse') {
      node = rs.ellipse(w / 2, h / 2, w, h, opts);
    } else if (shape === 'diamond') {
      node = rs.polygon(
        [
          [w / 2, 0],
          [w, h / 2],
          [w / 2, h],
          [0, h / 2],
        ],
        opts,
      );
    } else if (style.cornerRadius > 0) {
      node = rs.path(roundedRectPath(w, h, style.cornerRadius), opts);
    } else {
      node = rs.rectangle(0, 0, w, h, opts);
    }
    svg.appendChild(node);
  }, [shape, w, h, style, element.id]);

  // 进入编辑 —— 用元素当前标签灌入可编辑区并全选（之后内容由用户掌控，
  // React 不再触碰：该 div 无 children，重渲染不会回写）。
  useEffect(() => {
    if (!editingLabel) return;
    finishedRef.current = false;
    const node = labelRef.current;
    if (!node) return;
    node.textContent = label?.text ?? '';
    node.focus();
    const range = document.createRange();
    range.selectNodeContents(node);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    // 仅在进入编辑时跑一次；label 改变不重灌。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingLabel]);

  const commit = (): void => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    onLabelCommit?.(labelRef.current?.textContent ?? '');
  };
  const cancel = (): void => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    onLabelCancel?.();
  };

  const labelStyle: CSSProperties = {
    fontSize: `${label?.fontSize ?? style.fontSize}px`,
    fontFamily: fontStack(style.fontFamily),
    color: style.strokeColor,
  };

  return (
    <div className="cv-shape" style={{ width: w, height: h }}>
      <svg
        ref={svgRef}
        className="cv-shape__svg"
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        aria-hidden="true"
      />
      {editingLabel ? (
        <div
          ref={labelRef}
          className="cv-shape__label cv-shape__label--edit"
          contentEditable
          suppressContentEditableWarning
          style={labelStyle}
          // 编辑区内的指针操作不冒泡到卡槽 —— 不触发拖拽 / 重选。
          onPointerDown={(e) => e.stopPropagation()}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              cancel();
            } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              e.stopPropagation();
              commit();
            }
          }}
        />
      ) : label && label.text ? (
        <div className="cv-shape__label" style={labelStyle}>
          {label.text}
        </div>
      ) : null}
    </div>
  );
}
