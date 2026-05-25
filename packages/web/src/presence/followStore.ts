/**
 * 跟随视角外部 store（PRD §8.2）。
 *
 * 跟随状态本来在 CanvasShell 本地 state 里 —— 加 TopBar 在线参与者条后，
 * 入口移到顶栏，需要 TopBar 也能读 / 设；故抽出独立 store，与
 * [[presenceStore]] 同套 useSyncExternalStore 模式。
 *
 * 不持久化、不跨客户端同步 —— 纯本端 UI 状态：「我现在在跟谁的视角」。
 */

let currentFollowingId: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** 跟随视角外部 store。 */
export const followStore = {
  /** 订阅变化（useSyncExternalStore 用）。 */
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** 当前正在跟随的 clientId；null = 未跟随。 */
  getSnapshot(): string | null {
    return currentFollowingId;
  },
  /**
   * 设置跟随对象；null = 退出跟随。值未变时不触发监听（避免不必要重渲染）。
   *
   * 不在本 store 做「点同一人切换退出 / 点另一人改跟」的语义；上层（TopBar /
   * PresenceLayer 名牌）按需自己组合：通常先 `getSnapshot()` 决定下一步是
   * 设新 id 还是 setFollowing(null)。
   */
  setFollowing(id: string | null): void {
    if (currentFollowingId === id) return;
    currentFollowingId = id;
    emit();
  },
};
