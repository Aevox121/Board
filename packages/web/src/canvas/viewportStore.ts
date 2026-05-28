/**
 * 视口外部 store —— 把视口变化彻底踢出 React 调度。
 *
 * 背景：原本视口是 CanvasShell 的 useState，wheel / 中键平移每帧都 setState
 * 触发 OverlayLayer 重渲。OverlayLayer 是个 6000 行的庞然大物（25+ useState
 * + 上百个 useMemo），每帧重渲 16~30 ms，根本撑不住 60 FPS 的视口手势。
 *
 * 解法：
 *  - 视口真相源放外部 store（useSyncExternalStore 协议）。
 *  - `.ov-transform` 这层 DOM 元素 ref 注册到 store，store 在变更时**直接
 *    mutate `style.transform`**，完全不经过 React commit。
 *  - 真的需要订阅视口的组件（小的：Minimap、TopBar zoom%、Follow 横幅等）
 *    走 `useViewport()` 订阅。OverlayLayer 本身**不订阅**，需要时调
 *    `viewportStore.get()` 读快照。
 *  - 离散的"缩放档"另出一个 `zoomBucketStore`，按 5% 粒度跳变 ——
 *    LOD 类消费者（FileCard）只在跨档时才需要更新。
 */
import { useSyncExternalStore } from 'react';
import { INITIAL_VIEWPORT, type CanvasViewport } from './viewport';

let snapshot: CanvasViewport = INITIAL_VIEWPORT;
const listeners = new Set<() => void>();
const transformEls = new Set<HTMLElement>();

// ── 手势期 will-change 开关（缩放清晰 ↔ 手势顺滑 两全）─────────────
// 静止时 transform 容器**不挂** will-change → 浏览器按缩放后的有效分辨率重栅格,
// 文字（含纯文本卡）保持清晰。手势进行中（每次 set，即 zoom/pan）临时挂
// `will-change: transform` → 容器提升为合成层、变换走合成线程，手势顺滑（代价是
// 此刻按原始像素 GPU 放大、略糊）；手势停止 SHARPEN_AFTER_IDLE_MS 后撤掉 will-change
// → 触发重栅格、回到清晰矢量缩放。这样移动时顺、停下后清晰，二者兼得。
const SHARPEN_AFTER_IDLE_MS = 300;
let sharpenTimer: ReturnType<typeof setTimeout> | null = null;

function markTransformActiveThenSharpen(): void {
  for (const el of transformEls) {
    if (el.style.willChange !== 'transform') el.style.willChange = 'transform';
  }
  if (sharpenTimer !== null) clearTimeout(sharpenTimer);
  sharpenTimer = setTimeout(() => {
    sharpenTimer = null;
    // 撤掉 will-change —— 浏览器对该层重走 paint，按当前缩放分辨率重栅格 → 清晰。
    for (const el of transformEls) el.style.willChange = 'auto';
  }, SHARPEN_AFTER_IDLE_MS);
}

function applyTransformTo(el: HTMLElement, vp: CanvasViewport): void {
  el.style.transform =
    `translate(${vp.scrollX * vp.zoom}px, ${vp.scrollY * vp.zoom}px) ` +
    `scale(${vp.zoom})`;
  el.style.transformOrigin = '0 0';
}

export const viewportStore = {
  /** 读当前快照（不订阅）。 */
  get(): CanvasViewport {
    return snapshot;
  },
  /** 写视口 —— 立即同步到所有已注册的 transform DOM 节点，然后再通知订阅者。 */
  set(
    next: CanvasViewport | ((prev: CanvasViewport) => CanvasViewport),
  ): void {
    const value =
      typeof next === 'function'
        ? (next as (p: CanvasViewport) => CanvasViewport)(snapshot)
        : next;
    if (
      value.scrollX === snapshot.scrollX &&
      value.scrollY === snapshot.scrollY &&
      value.zoom === snapshot.zoom
    ) {
      return;
    }
    snapshot = value;
    // DOM 先写，再走订阅 —— 让没订阅的 DOM 节点至少能立刻看到正确位置。
    for (const el of transformEls) applyTransformTo(el, snapshot);
    // 手势进行中挂 will-change（顺滑），停止 1s 后撤掉（重栅格回清晰）。
    markTransformActiveThenSharpen();
    for (const l of listeners) l();
  },
  /** 订阅视口变化（标准 useSyncExternalStore 协议）。 */
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
  /**
   * 把一个 DOM 元素登记为「transform 容器」—— 视口变更时直接 mutate 它的
   * style.transform，不经过 React。同时把当前 snapshot 立即写一次以同步初态。
   * 返回卸载函数。
   */
  registerTransformEl(el: HTMLElement | null): () => void {
    if (!el) return () => {};
    transformEls.add(el);
    applyTransformTo(el, snapshot);
    return () => {
      transformEls.delete(el);
    };
  },
};

/** 订阅完整 viewport —— 仅用于 JSX 内真的要展示数值（zoom%、minimap）的组件。 */
export function useViewport(): CanvasViewport {
  return useSyncExternalStore(viewportStore.subscribe, viewportStore.get);
}

// ─── 离散缩放档 ─────────────────────────────────────────────
// `Math.round(zoom * 20)` —— 每 5% 跳一档；LOD / 命中容差等消费者只在跨档时
// 才需要更新。订阅者数量可观（每个 FileCard 都订阅）时，跨档触发的重渲也
// 仅在缩放跨 5% 边界的瞬间发生，不是每帧。

let lastBucket = Math.round(snapshot.zoom * 20);
const bucketListeners = new Set<() => void>();
viewportStore.subscribe(() => {
  const b = Math.round(snapshot.zoom * 20);
  if (b !== lastBucket) {
    lastBucket = b;
    for (const l of bucketListeners) l();
  }
});

export const zoomBucketStore = {
  get(): number {
    return lastBucket;
  },
  subscribe(l: () => void): () => void {
    bucketListeners.add(l);
    return () => {
      bucketListeners.delete(l);
    };
  },
};

/** 订阅离散缩放档（5% 一档）—— LOD 消费者使用。 */
export function useZoomBucket(): number {
  return useSyncExternalStore(zoomBucketStore.subscribe, zoomBucketStore.get);
}
