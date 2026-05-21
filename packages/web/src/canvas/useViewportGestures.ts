/**
 * 自研画布层 —— 平移 / 缩放手势。
 *
 *  - 滚轮 → 平移；Ctrl/⌘ + 滚轮 → 以光标为锚缩放（含触控板捏合）。
 *  - 中键拖拽 → 平移。
 *
 * 滚轮 / 中键在**捕获阶段**于画布外壳上拦截并 preventDefault；左键不拦截，
 * 下穿给覆盖层用于创建 / 选择 / 拖拽。
 */
import { useEffect, useRef, useState } from 'react';
import { panBy, zoomAt, type CanvasViewport } from './viewport';

export interface ViewportGesturesOptions {
  /** 手势作用的外壳元素（换算屏幕坐标 + 挂事件监听）。 */
  surfaceRef: React.RefObject<HTMLElement>;
  /** 当前视口 —— hook 不持有视口，由调用方持有。 */
  viewport: CanvasViewport;
  /** 视口变化回调。 */
  onChange: (next: CanvasViewport) => void;
}

/** 缩放灵敏度 —— deltaY 经 exp 映射为缩放系数，正负对称、缩放手感平滑。 */
const ZOOM_SENSITIVITY = 0.0015;

/**
 * 画布平移 / 缩放手势。返回 `panning`（中键拖拽进行中）供调用方切换抓手光标。
 */
export function useViewportGestures({
  surfaceRef,
  viewport,
  onChange,
}: ViewportGesturesOptions): { panning: boolean } {
  const [panning, setPanning] = useState(false);

  // 监听器只在挂载时绑一次 —— 用 ref 让回调读到最新视口 / 最新 onChange。
  const vpRef = useRef(viewport);
  vpRef.current = viewport;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;

    // ── 滚轮：平移；Ctrl/⌘ + 滚轮：以光标为锚缩放 ──────────────
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      const vp = vpRef.current;
      if (e.ctrlKey || e.metaKey) {
        const rect = surface.getBoundingClientRect();
        onChangeRef.current(
          zoomAt(
            vp,
            vp.zoom * Math.exp(-e.deltaY * ZOOM_SENSITIVITY),
            e.clientX - rect.left,
            e.clientY - rect.top,
          ),
        );
      } else {
        onChangeRef.current(panBy(vp, -e.deltaX, -e.deltaY));
      }
    };

    // ── 中键拖拽平移 ───────────────────────────────────────────
    let panPointerId: number | null = null;
    let lastX = 0;
    let lastY = 0;

    const onPointerDown = (e: PointerEvent): void => {
      if (e.button !== 1) return; // 仅中键 —— 左键留给覆盖层创建 / 选择
      e.preventDefault();
      e.stopPropagation();
      panPointerId = e.pointerId;
      lastX = e.clientX;
      lastY = e.clientY;
      try {
        surface.setPointerCapture(e.pointerId);
      } catch {
        // 指针捕获偶发不可用，忽略 —— 仍能按 lastX/lastY 跟踪。
      }
      setPanning(true);
    };

    const onPointerMove = (e: PointerEvent): void => {
      if (panPointerId === null || e.pointerId !== panPointerId) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      if (dx !== 0 || dy !== 0) {
        onChangeRef.current(panBy(vpRef.current, dx, dy));
      }
    };

    const endPan = (e: PointerEvent): void => {
      if (panPointerId === null || e.pointerId !== panPointerId) return;
      try {
        surface.releasePointerCapture(panPointerId);
      } catch {
        // 已释放，忽略。
      }
      panPointerId = null;
      setPanning(false);
    };

    surface.addEventListener('wheel', onWheel, { capture: true, passive: false });
    surface.addEventListener('pointerdown', onPointerDown, true);
    surface.addEventListener('pointermove', onPointerMove, true);
    surface.addEventListener('pointerup', endPan, true);
    surface.addEventListener('pointercancel', endPan, true);
    return () => {
      surface.removeEventListener('wheel', onWheel, true);
      surface.removeEventListener('pointerdown', onPointerDown, true);
      surface.removeEventListener('pointermove', onPointerMove, true);
      surface.removeEventListener('pointerup', endPan, true);
      surface.removeEventListener('pointercancel', endPan, true);
    };
  }, [surfaceRef]);

  return { panning };
}
