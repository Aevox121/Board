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
import { presenceStore } from './presenceStore';
import { followStore } from './followStore';
import { SESSION } from '../session';
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

  // 排序：自己始终第一；其余按 ts（最近上报先）。presenceStore 内部排序
  // 不稳定，这里显式排一遍保 UI 稳定。
  const others = users
    .filter((u) => u.clientId !== SESSION.clientId)
    .sort((a, b) => a.ts - b.ts);

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
        const onClick = (): void => {
          // 点 self 不会到这里（已过滤）；切换跟随该人。
          followStore.setFollowing(isFollowed ? null : u.clientId);
        };
        return (
          <button
            key={u.clientId}
            type="button"
            className={
              'presence-bar__chip presence-bar__chip--clickable' +
              (isFollowed ? ' presence-bar__chip--followed' : '') +
              (isAgent ? ' presence-bar__chip--agent' : '')
            }
            onClick={onClick}
            title={
              isFollowed
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
