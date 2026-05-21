/**
 * 在场感知（Presence）—— 内存态的参与者光标注册表（M4，PRD §8.2）。
 *
 * Presence 是纯瞬时态：不进 board.json、不进事件日志、不参与 reconcile。
 * 各客户端定期上报光标位置（画布坐标），服务端登记并经 SSE 广播给其余端；
 * 超过 STALE_MS 未上报的条目视为离线，由定时清理剔除。
 */

/** 光标的画布坐标。 */
export interface PresenceCursor {
  x: number;
  y: number;
}

/** 一个在场参与者。 */
export interface PresenceUser {
  /** 客户端会话 id */
  clientId: string;
  /** 显示名 */
  name: string;
  /** hex 颜色 —— 光标与名牌用色 */
  color: string;
  /** 画布坐标的光标位置；null = 在场但光标位置未知 */
  cursor: PresenceCursor | null;
  /** 最近一次上报的 epoch 毫秒 */
  ts: number;
}

/** 超过此时长未上报即视为离线（毫秒）。 */
const STALE_MS = 12_000;

/** Presence 注册表句柄。 */
export interface PresenceHub {
  /** 登记 / 刷新一个参与者，返回带时间戳的条目。 */
  update(u: Omit<PresenceUser, 'ts'>): PresenceUser;
  /** 移除一个参与者（显式离开）。 */
  remove(clientId: string): boolean;
  /** 清理过期条目，返回被清理的 clientId 列表。 */
  prune(): string[];
  /** 当前全部在场参与者。 */
  list(): PresenceUser[];
}

/** 创建一个 Presence 注册表。 */
export function createPresenceHub(): PresenceHub {
  const users = new Map<string, PresenceUser>();
  return {
    update(u) {
      const entry: PresenceUser = { ...u, ts: Date.now() };
      users.set(u.clientId, entry);
      return entry;
    },
    remove(clientId) {
      return users.delete(clientId);
    },
    prune() {
      const now = Date.now();
      const dropped: string[] = [];
      for (const [id, u] of users) {
        if (now - u.ts > STALE_MS) {
          users.delete(id);
          dropped.push(id);
        }
      }
      return dropped;
    },
    list: () => [...users.values()],
  };
}
