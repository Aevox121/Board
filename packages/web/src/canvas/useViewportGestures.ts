/**
 * 自研画布层 —— 平移 / 缩放手势。
 *
 *  - 滚轮 → 平移；Ctrl/⌘ + 滚轮 → 以光标为锚缩放（含触控板捏合）。
 *  - 中键拖拽 → 平移。
 *
 * 滚轮 / 中键在**捕获阶段**于画布外壳上拦截并 preventDefault；左键不拦截，
 * 下穿给覆盖层用于创建 / 选择 / 拖拽。
 *
 * 视口读写都走 `viewportStore`（外部 store）—— set 时 store 直接 mutate
 * 已注册的 transform 容器 DOM，绕开 React 调度。订阅者另收到通知。
 */
import { useEffect, useRef, useState } from 'react';
import { panBy, zoomAt } from './viewport';
import { viewportStore } from './viewportStore';

export interface ViewportGesturesOptions {
  /** 手势作用的外壳元素（换算屏幕坐标 + 挂事件监听）。 */
  surfaceRef: React.RefObject<HTMLElement>;
  /** 本地用户交互触发前的回调 —— 用于退出跟随视角等。 */
  onLocalInteract?: () => void;
}

/** 缩放灵敏度 —— deltaY 经 exp 映射为缩放系数，正负对称、缩放手感平滑。 */
const ZOOM_SENSITIVITY = 0.0015;

/**
 * 画布平移 / 缩放手势。返回 `panning`（中键拖拽进行中）供调用方切换抓手光标。
 */
export function useViewportGestures({
  surfaceRef,
  onLocalInteract,
}: ViewportGesturesOptions): { panning: boolean } {
  const [panning, setPanning] = useState(false);

  const onLocalInteractRef = useRef(onLocalInteract);
  onLocalInteractRef.current = onLocalInteract;

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;

    const notifyLocal = (): void => onLocalInteractRef.current?.();

    // ── 滚轮：平移；Ctrl/⌘ + 滚轮：以光标为锚缩放 ──────────────
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      notifyLocal();
      const vp = viewportStore.get();
      if (e.ctrlKey || e.metaKey) {
        const rect = surface.getBoundingClientRect();
        viewportStore.set(
          zoomAt(
            vp,
            vp.zoom * Math.exp(-e.deltaY * ZOOM_SENSITIVITY),
            e.clientX - rect.left,
            e.clientY - rect.top,
          ),
        );
      } else {
        viewportStore.set(panBy(vp, -e.deltaX, -e.deltaY));
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
      notifyLocal();
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
        viewportStore.set(panBy(viewportStore.get(), dx, dy));
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
