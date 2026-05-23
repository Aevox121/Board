/**
 * 在场参与者存储 —— 一个轻量外部 store（M4：拟人化光标）。
 *
 * 为什么不放进 BoardContext：光标更新是高频事件（每个对端每秒约 10 次），
 * 放进 BoardContext 会让画布 / 覆盖层等重组件随之频繁重渲染。这里用独立
 * 外部 store + `useSyncExternalStore`，使只有 PresenceLayer 订阅、重渲染。
 *
 * App 层的 SSE 处理把 `presence` / `presence-leave` 帧灌进本 store。
 */

/** 一个在场参与者（与 server presence.ts 的 PresenceUser 对应）。 */
export interface RemotePresence {
  clientId: string;
  name: string;
  color: string;
  /** 画布坐标的光标位置；null = 在场但光标未知 */
  cursor: { x: number; y: number } | null;
  ts: number;
  /**
   * Agent 当前操作的焦点元素 id（PRD §7.4 / §8.2）。设置后浏览器把 Agent
   * 光标钉在该元素的 `targetOffset` 处 + 小幅 jitter；不设则按 cursor 显示。
   */
  targetElementId?: string;
  /** 元素本地坐标的偏移（左上 = 0,0）；默认元素中心。让 Agent 精确到行/字符。 */
  targetOffset?: { x: number; y: number };
  /** 是否 Agent，浏览器据此渲染 jitter 工作光标。 */
  isAgent?: boolean;
}

/** 当前在场列表 —— 仅在变化时换新引用，满足 useSyncExternalStore 的稳定快照要求。 */
let users: RemotePresence[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** 在场参与者外部 store。 */
export const presenceStore = {
  /** 订阅变化（useSyncExternalStore 用）。 */
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** 当前快照（useSyncExternalStore 用）—— 未变化时返回同一引用。 */
  getSnapshot(): RemotePresence[] {
    return users;
  },
  /** 登记 / 刷新一个参与者。 */
  applyUpdate(u: RemotePresence): void {
    users = [...users.filter((x) => x.clientId !== u.clientId), u];
    emit();
  },
  /** 移除一个参与者。 */
  applyLeave(clientId: string): void {
    const next = users.filter((x) => x.clientId !== clientId);
    if (next.length !== users.length) {
      users = next;
      emit();
    }
  },
};
