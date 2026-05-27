/**
 * 拖动 offset 外部 store —— 类比 viewportStore，把拖动期间每帧变化的 offset
 * 从 React state 里挪出来，直接 DOM mutate 被拖元素的 transform。
 *
 * 背景：拖动一个元素时，OverlayLayer 的 `setDrag({ ...d, offsetX, offsetY })`
 * 每个 pointermove 都触发全组件重渲（6000 行 + 25 useState + 上百 useMemo），
 * 是拖动卡顿的核心来源。
 *
 * 设计：
 *  - 每个 ElementSlot 的根 div 通过 ref 在 mount 时注册到本 store（按 element id）。
 *  - 拖动期间，handlePointerMove 把 (memberIds, offsetX, offsetY) 写进 store；
 *    store 立即 mutate 所有命中 member 的 slot 元素的 `style.transform`（叠加
 *    它原有的 rotate）—— 不走 React。
 *  - 拖动期间的"是否在动 + 哪些元素在动"这种轻量布尔信号也通过 store 提供，
 *    给 SnapGuidesLayer 之类的子组件按需订阅。
 *  - OverlayLayer 仍然保留 `drag` useState 用来记 kind/elementId/memberIds/
 *    startScreen 等"框架字段"（仅 beginDrag/pointerup 各 setState 一次），
 *    高频部分完全 bypass。
 */
import { useSyncExternalStore } from 'react';

export interface DragOffsetSnapshot {
  /** 当前是否在拖动 —— 用于 SnapGuidesLayer 等小订阅者展示/隐藏 UI。 */
  active: boolean;
  /** 拖动成员的 id 集合（含被拖元素本身 + 同组成员等）。 */
  memberIds: ReadonlySet<string>;
  /** 当前累计偏移（画布坐标）。 */
  offsetX: number;
  offsetY: number;
}

const EMPTY: DragOffsetSnapshot = {
  active: false,
  memberIds: new Set(),
  offsetX: 0,
  offsetY: 0,
};

let snapshot: DragOffsetSnapshot = EMPTY;
const listeners = new Set<() => void>();
/** elementId → 该 slot 的根 DOM 节点 + 它的 base transform（如 rotate(...)）。 */
const memberSlots = new Map<
  string,
  { el: HTMLElement; baseTransform: string }
>();
/** offset 高频变化的订阅者集（用于实时跟随的视觉副组件如 ConnectorLayer）。
 *  与 listeners 分开 —— listeners 仅在 active 切换时触发，避免不需要实时跟
 *  随的订阅者每帧重渲。 */
const offsetListeners = new Set<() => void>();
let offsetVersion = 0;

function applyOffsetTo(
  el: HTMLElement,
  baseTransform: string,
  dx: number,
  dy: number,
): void {
  if (dx === 0 && dy === 0) {
    el.style.transform = baseTransform || '';
  } else {
    el.style.transform = baseTransform
      ? `translate(${dx}px, ${dy}px) ${baseTransform}`
      : `translate(${dx}px, ${dy}px)`;
  }
}

export const dragStore = {
  get(): DragOffsetSnapshot {
    return snapshot;
  },
  /**
   * 注册一个 slot 的 DOM 节点 —— ElementSlot 在 mount 时调用。`baseTransform`
   * 是该 slot 当前的 rotate 字符串（不含 translate），用于把 drag offset
   * 复合上去。每次 base 变化要再调用一次（或先 unregister 再 register）。
   */
  registerSlot(
    elementId: string,
    el: HTMLElement | null,
    baseTransform: string,
  ): () => void {
    if (!el) return () => {};
    memberSlots.set(elementId, { el, baseTransform });
    // 若该元素正在被拖动，立即把当前 offset 应用上去（防止刚 mount 的元素
    // 短暂错位）。
    if (snapshot.active && snapshot.memberIds.has(elementId)) {
      applyOffsetTo(el, baseTransform, snapshot.offsetX, snapshot.offsetY);
    } else {
      applyOffsetTo(el, baseTransform, 0, 0);
    }
    return () => {
      // 卸载时若仍是当前 ref 才删（防止 React 重挂顺序混乱）。
      if (memberSlots.get(elementId)?.el === el) memberSlots.delete(elementId);
    };
  },
  /** 更新某 slot 的 baseTransform（用于 rotate 变化时同步）。 */
  updateBaseTransform(elementId: string, baseTransform: string): void {
    const entry = memberSlots.get(elementId);
    if (!entry) return;
    entry.baseTransform = baseTransform;
    const dx =
      snapshot.active && snapshot.memberIds.has(elementId)
        ? snapshot.offsetX
        : 0;
    const dy =
      snapshot.active && snapshot.memberIds.has(elementId)
        ? snapshot.offsetY
        : 0;
    applyOffsetTo(entry.el, baseTransform, dx, dy);
  },
  /**
   * 开始拖动 —— 标记 memberIds，offset=(0,0)。一次性调用，不触发后续重渲
   * 链路。订阅者会收到 active=true 通知。
   */
  begin(memberIds: ReadonlySet<string>): void {
    snapshot = { active: true, memberIds, offsetX: 0, offsetY: 0 };
    offsetVersion++;
    // 初始 offset 为 0，但仍要 apply 把可能残留的 transform 清掉。
    for (const id of memberIds) {
      const entry = memberSlots.get(id);
      if (entry) applyOffsetTo(entry.el, entry.baseTransform, 0, 0);
    }
    for (const l of listeners) l();
    for (const l of offsetListeners) l();
  },
  /**
   * 高频路径：拖动中更新 offset。直接 mutate 所有 member 的 transform；
   * 同步通知 offsetListeners（连线层等需要实时跟随）；不通知普通 listeners
   * （active 没变，UI 显隐不必每帧切换）。
   */
  setOffset(offsetX: number, offsetY: number): void {
    if (!snapshot.active) return;
    snapshot = { ...snapshot, offsetX, offsetY };
    offsetVersion++;
    for (const id of snapshot.memberIds) {
      const entry = memberSlots.get(id);
      if (entry) applyOffsetTo(entry.el, entry.baseTransform, offsetX, offsetY);
    }
    for (const l of offsetListeners) l();
  },
  /** 结束拖动 —— 把所有 member 的 transform 恢复成 base（drag END 后调用方
   * 会把新坐标提交到 scene，slot 会自然以新的 x/y 重渲）。 */
  end(): void {
    const old = snapshot;
    snapshot = EMPTY;
    offsetVersion++;
    for (const id of old.memberIds) {
      const entry = memberSlots.get(id);
      if (entry) applyOffsetTo(entry.el, entry.baseTransform, 0, 0);
    }
    for (const l of listeners) l();
    for (const l of offsetListeners) l();
  },
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
  /** offset 高频变化的订阅（用于实时跟随视觉的组件，如 ConnectorLayer）。 */
  subscribeOffset(l: () => void): () => void {
    offsetListeners.add(l);
    return () => {
      offsetListeners.delete(l);
    };
  },
  /** 返回单调递增版本号 —— useSyncExternalStore 的 getSnapshot 用，确保每次
   *  offsetVersion 变化都触发订阅者重渲。 */
  getOffsetVersion(): number {
    return offsetVersion;
  },
};

/** 订阅 active 切换（用于 SnapGuidesLayer 等 UI 显隐）。 */
export function useDragActive(): boolean {
  return useSyncExternalStore(
    dragStore.subscribe,
    () => snapshot.active,
  );
}

/** 订阅 offset 高频变化 —— 每次 setOffset/begin/end 都让订阅者重渲。
 *  用于 ConnectorLayer 等需要实时跟随被拖元素的视觉组件。返回值是版本号，
 *  调用方按需调 `dragStore.get()` 读最新 snapshot。 */
export function useDragOffsetVersion(): number {
  return useSyncExternalStore(
    dragStore.subscribeOffset,
    dragStore.getOffsetVersion,
  );
}
