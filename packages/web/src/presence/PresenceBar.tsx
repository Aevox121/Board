/**
 * 顶栏在线参与者条（PRD §8.2 在场感知）。
 *
 * 头像圆 = 颜色 + 首字（CJK 取首字，Latin 取首字母）；hover 显示完整名字 +
 * 「跟随他的视角」提示；点击切换跟随该参与者（同一人再点退出，另一人改跟）。
 *
 * 自己（SESSION.clientId）单独标识在第一位，「你」chip 不可点；其余按
 * 入场顺序排列，最多展示 8 个，超出折叠成 `+N`。
 *
 * 数据源：
 *  - presenceStore —— 实时在场列表（含本端 ws/SSE 收到的对端）
 *  - followStore —— 当前正在跟随的 clientId（与 CanvasShell / PresenceLayer
 *    名牌共用同一份真相）
 */
import { useSyncExternalStore } from 'react';
import { presenceStore, type RemotePresence } from './presenceStore';
import { followStore } from './followStore';
import { SESSION } from '../session';
import { useBoard } from '../board/BoardContext';
import './presence.css';

/** 单条头像同时显示上限 —— 多于此时折叠为 `+N`。 */
const MAX_VISIBLE = 8;

/** 取展示用的首字 —— CJK 直接取首字，其他取首字母大写。 */
function initial(name: string): string {
  const first = name.trim().charAt(0);
  if (!first) return '?';
  // CJK 字符直接用首字；其他统一大写。
  return /[一-鿿぀-ゟ゠-ヿ가-힯]/.test(first)
    ? first
    : first.toUpperCase();
}

export function PresenceBar(): JSX.Element | null {
  const users = useSyncExternalStore(
    presenceStore.subscribe,
    presenceStore.getSnapshot,
  );
  const followingId = useSyncExternalStore(
    followStore.subscribe,
    followStore.getSnapshot,
  );
  const { meta } = useBoard();

  // 排序：自己始终第一；其余按 ts（最近上报先）。presenceStore 内部排序
  // 不稳定，这里显式排一遍保 UI 稳定。
  const liveOthers = users
    .filter((u) => u.clientId !== SESSION.clientId)
    .sort((a, b) => a.ts - b.ts);

  // 联合 meta.participants[type=agent] 中尚未活跃的 agent —— 这些是"曾经
  // 在本板工作过"的 Agent（CLI / sub-agent 不持续心跳，presence 12s 就过期
  // 消失，但他们的产出还在）。把它们渲染为半透的"inactive" chip，让用户
  // 知道这块板上有哪些 AI 参与过；点击仍可跟随（虽然跟随对静态 Agent 没
  // 意义，但触发 navigate 到他们最近修改的元素是 nice-to-have，后续做）。
  const liveIds = new Set(liveOthers.map((u) => u.clientId));
  const inactiveAgents: RemotePresence[] = meta.participants
    .filter((p) => p.type === 'agent' && !liveIds.has(p.id))
    .map((p) => ({
      clientId: p.id,
      name: p.name,
      color: p.color,
      cursor: null,
      ts: 0, // 不活跃 —— 渲染时根据 ts===0 给 muted 样式
      isAgent: true,
    }));

  const others = [...liveOthers, ...inactiveAgents];
  const visible = others.slice(0, MAX_VISIBLE);
  const hidden = others.length - visible.length;

  // 无对端在场时仍显示「自己」chip —— 让人知道连接是通的，独人状态明确。
  return (
    <div className="presence-bar" role="group" aria-label="在线参与者">
      <span
        className="presence-bar__chip presence-bar__chip--self"
        title={`你（${SESSION.name}）`}
      >
        <span
          className="presence-bar__avatar"
          style={{ background: SESSION.color }}
          aria-hidden="true"
        >
          {initial(SESSION.name)}
        </span>
        <span className="presence-bar__name">你</span>
      </span>
      {visible.map((u) => {
        const isFollowed = followingId === u.clientId;
        const isAgent = !!u.isAgent;
        const isInactive = u.ts === 0; // 仅由 meta.participants 注入的「曾参与」
        const onClick = (): void => {
          // 点 self 不会到这里（已过滤）；非活跃 agent 跟随无意义，仍允许
          // 触发但视觉上灰着。
          if (isInactive) return;
          followStore.setFollowing(isFollowed ? null : u.clientId);
        };
        return (
          <button
            key={u.clientId}
            type="button"
            className={
              'presence-bar__chip presence-bar__chip--clickable' +
              (isFollowed ? ' presence-bar__chip--followed' : '') +
              (isAgent ? ' presence-bar__chip--agent' : '') +
              (isInactive ? ' presence-bar__chip--inactive' : '')
            }
            onClick={onClick}
            title={
              isInactive
                ? `${u.name} —— 曾在本板工作（当前不活跃）`
                : isFollowed
                  ? `正在跟随 ${u.name} · 点击退出`
                  : `跟随 ${u.name} 的视角`
            }
            aria-pressed={isFollowed}
          >
            <span
              className="presence-bar__avatar"
              style={{ background: u.color }}
              aria-hidden="true"
            >
              {initial(u.name)}
            </span>
            <span className="presence-bar__name">{u.name}</span>
          </button>
        );
      })}
      {hidden > 0 ? (
        <span
          className="presence-bar__overflow"
          title={`还有 ${hidden} 位在场参与者`}
        >
          +{hidden}
        </span>
      ) : null}
    </div>
  );
}
