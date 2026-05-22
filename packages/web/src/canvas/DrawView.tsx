/**
 * 手绘笔迹渲染 —— 把一个 DrawElement 渲染为压感笔迹 SVG。
 *
 * 自研画布层 增量1：用 perfect-freehand（Excalidraw 内部同款笔迹库）把
 * 离散采样点转成一条「描边轮廓多边形」，再以**填充**路径绘出 —— 笔迹是
 * 一个有粗细变化的填充形状，不是等宽的 stroke 线。
 */
import { useMemo } from 'react';
import { getStroke } from 'perfect-freehand';
import type { DrawElement } from '@board/core';
import './canvas.css';

/** perfect-freehand 输出的轮廓点 → SVG path（用二次贝塞尔平滑闭合）。 */
export function outlineToPath(outline: number[][]): string {
  if (outline.length === 0) return '';
  const first = outline[0]!;
  const d: Array<string | number> = ['M', first[0]!, first[1]!, 'Q'];
  for (let i = 0; i < outline.length; i++) {
    const [x0, y0] = outline[i]!;
    const [x1, y1] = outline[(i + 1) % outline.length]!;
    d.push(x0!, y0!, (x0! + x1!) / 2, (y0! + y1!) / 2);
  }
  d.push('Z');
  return d.join(' ');
}

/** 笔迹命中区相对可见笔迹额外加宽的直径余量（画布单位）。 */
const HIT_PAD = 22;

/**
 * 手绘元素的「命中轮廓」SVG path —— 比可见笔迹加宽 HIT_PAD 的填充轮廓，
 * 用作 clip-path 把命中区裁成笔迹形状（细笔迹也留出可点容差）。
 * 采样点少于 2 个时返回空串。
 */
export function drawHitPath(el: DrawElement): string {
  if (el.points.length < 2) return '';
  const input = el.points.map((p, i) => [
    p[0],
    p[1],
    el.pressures?.[i] ?? 0.5,
  ]);
  const outline = getStroke(input, {
    size: Math.max(2, el.style.strokeWidth * 4) + HIT_PAD,
    thinning: 0.6,
    smoothing: 0.5,
    streamline: 0.5,
    simulatePressure: !el.pressures || el.pressures.length === 0,
  });
  return outlineToPath(outline);
}

export interface DrawViewProps {
  element: DrawElement;
}

/**
 * 把一个 DrawElement 渲染为压感笔迹（局部坐标，点相对元素左上角）。
 * 调用方负责把它定位到画布坐标 (element.x, element.y)。
 */
export function DrawView({ element }: DrawViewProps): JSX.Element {
  const { points, pressures, style, width: w, height: h } = element;

  const d = useMemo(() => {
    if (points.length === 0) return '';
    const input = points.map((p, i) => [p[0], p[1], pressures?.[i] ?? 0.5]);
    const outline = getStroke(input, {
      // perfect-freehand 的 size 是笔迹直径 —— 取描边宽度的约 4 倍。
      size: Math.max(2, style.strokeWidth * 4),
      thinning: 0.6,
      smoothing: 0.5,
      streamline: 0.5,
      // 无真实压感数据时由速度模拟，笔迹仍有粗细变化。
      simulatePressure: !pressures || pressures.length === 0,
    });
    return outlineToPath(outline);
  }, [points, pressures, style.strokeWidth]);

  return (
    <svg
      className="cv-draw"
      width={w}
      height={h}
      style={{ overflow: 'visible' }}
      aria-hidden="true"
    >
      <path d={d} fill={style.strokeColor} />
    </svg>
  );
}
