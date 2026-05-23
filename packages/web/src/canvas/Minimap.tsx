/**
 * 小地图 —— 右下角缩略导航图（PRD §6.1）。
 *
 * 设计:
 *  - 固定 200x140 占位，画布右下角浮起；元素按统一缩放投影为半透明矩形。
 *  - 当前视口范围以白色描边矩形显示，点击 / 拖动即把主画布视口跳到对应点。
 *  - 内容空时整张缩略图淡出。
 *
 * 数据驱动：仅读 elements 的 x/y/width/height + viewport 与主画布尺寸；
 * 不读元素具体内容，跟随场景实时更新 (React 重渲染即可)。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Element } from '@board/core';
import type { CanvasViewport } from './viewport';
import './minimap.css';

const MINIMAP_W = 200;
const MINIMAP_H = 140;
/** 缩略图内边距，给元素与视口框留一圈呼吸 */
const PAD = 8;

interface ContentBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 计算「元素包围盒并上当前视口范围」—— 缩略图按这个范围统一缩放。 */
function computeBounds(
  elements: ReadonlyArray<Element>,
  viewport: CanvasViewport,
  viewW: number,
  viewH: number,
): ContentBox | null {
  if (elements.length === 0 && (viewW === 0 || viewH === 0)) return null;
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
  // 当前视口在画布坐标下的覆盖范围。
  if (viewW > 0 && viewH > 0) {
    const vx = -viewport.scrollX;
    const vy = -viewport.scrollY;
    const vw = viewW / viewport.zoom;
    const vh = viewH / viewport.zoom;
    minX = Math.min(minX, vx);
    minY = Math.min(minY, vy);
    maxX = Math.max(maxX, vx + vw);
    maxY = Math.max(maxY, vy + vh);
  }
  if (!Number.isFinite(minX)) return null;
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

export interface MinimapProps {
  elements: ReadonlyArray<Element>;
  viewport: CanvasViewport;
  /** 取主画布当前尺寸（小地图需据此换算视口框 / 落点）。 */
  getViewSize: () => { width: number; height: number };
  /** 点击 / 拖动 落入小地图某画布坐标点时，把主视口跳到该点居中。 */
  onJump: (canvasX: number, canvasY: number) => void;
}

export function Minimap({
  elements,
  viewport,
  getViewSize,
  onJump,
}: MinimapProps): JSX.Element {
  // 主画布尺寸非画布坐标，需要在缩略图中读取。用 state 让 resize 时跟随。
  const [viewSize, setViewSize] = useState<{ width: number; height: number }>(() =>
    getViewSize(),
  );
  // 主画布 resize 时刷新尺寸 —— 经 ResizeObserver 监听 cv-shell 不直接可得，
  // 简化为 window resize 监听 + mount 时取一次（多数场景充分）。
  useEffect(() => {
    const onResize = (): void => setViewSize(getViewSize());
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [getViewSize]);

  // 元素 / 视口变了就重算缩放：把内容 + 当前视口框装入 MINIMAP_W x MINIMAP_H。
  const bounds = useMemo(
    () =>
      computeBounds(elements, viewport, viewSize.width, viewSize.height),
    [elements, viewport, viewSize.width, viewSize.height],
  );
  const scale = bounds
    ? Math.min(
        (MINIMAP_W - 2 * PAD) / bounds.width,
        (MINIMAP_H - 2 * PAD) / bounds.height,
      )
    : 0;
  // 投影后的内容尺寸（居中后用 offset 推到中央）。
  const projW = bounds ? bounds.width * scale : 0;
  const projH = bounds ? bounds.height * scale : 0;
  const offX = (MINIMAP_W - projW) / 2;
  const offY = (MINIMAP_H - projH) / 2;

  /** 缩略图坐标 → 画布坐标（落点中心）。 */
  const minimapToCanvas = (mx: number, my: number): { x: number; y: number } | null => {
    if (!bounds || scale === 0) return null;
    return {
      x: bounds.x + (mx - offX) / scale,
      y: bounds.y + (my - offY) / scale,
    };
  };

  const ref = useRef<HTMLDivElement>(null);
  const draggingRef = useRef<boolean>(false);

  const jumpFromEvent = (e: { clientX: number; clientY: number }): void => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const pt = minimapToCanvas(mx, my);
    if (pt) onJump(pt.x, pt.y);
  };

  // 视口矩形（缩略图坐标系）—— 用于显示「我在哪」。
  const viewRect =
    bounds && scale > 0 && viewSize.width > 0 && viewSize.height > 0
      ? {
          x: offX + (-viewport.scrollX - bounds.x) * scale,
          y: offY + (-viewport.scrollY - bounds.y) * scale,
          w: (viewSize.width / viewport.zoom) * scale,
          h: (viewSize.height / viewport.zoom) * scale,
        }
      : null;

  return (
    <div
      ref={ref}
      className={
        'cv-minimap' + (elements.length === 0 ? ' cv-minimap--empty' : '')
      }
      style={{ width: MINIMAP_W, height: MINIMAP_H }}
      aria-label="小地图导航"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        draggingRef.current = true;
        jumpFromEvent(e);
      }}
      onPointerMove={(e) => {
        if (!draggingRef.current) return;
        jumpFromEvent(e);
      }}
      onPointerUp={(e) => {
        draggingRef.current = false;
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          // 已释放，忽略。
        }
      }}
      onPointerCancel={() => {
        draggingRef.current = false;
      }}
    >
      {/* 元素缩略 —— 每个元素绘一个半透明矩形 */}
      {bounds &&
        elements.map((el) => {
          // 不渲染建议元素（避免视觉杂讯）。
          if (el.type === 'suggestion') return null;
          return (
            <div
              key={el.id}
              className={`cv-minimap__el cv-minimap__el--${el.type}`}
              style={{
                left: offX + (el.x - bounds.x) * scale,
                top: offY + (el.y - bounds.y) * scale,
                width: Math.max(1, el.width * scale),
                height: Math.max(1, el.height * scale),
              }}
              aria-hidden="true"
            />
          );
        })}
      {/* 视口框 —— 当前在哪 */}
      {viewRect ? (
        <div
          className="cv-minimap__view"
          style={{
            left: viewRect.x,
            top: viewRect.y,
            width: Math.max(8, viewRect.w),
            height: Math.max(8, viewRect.h),
          }}
          aria-hidden="true"
        />
      ) : null}
    </div>
  );
}
