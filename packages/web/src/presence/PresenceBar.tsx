/**
 * 顶栏在线参与者条（PRD §8.2 在场感知）。
 *
 * 头像圆 = 颜色 + 首字（CJK 取首字，Latin 取首字母）；hover 显示完整名字 +
 * 「跟随他的视角」提示；点击切换跟随该参与者（同一人再点退出，另一人改跟）。
 *
 * 显示策略（2026-05-28 调整）：
 *  - **只显示在线参与者**：数据源仅 presenceStore（实时心跳）。离线者由 server
 *    presence 超时（12s）剔除 + 广播 presence-leave，这里随之移除 → 自然消失。
 *    （此前会把 meta.participants 里「曾参与的 Agent」常驻展示，违背「只显示在线」，
 *    已移除。）
 *  - **超 3 折叠**：自己 + 前 3 位在场者直接显示；其余收进 `+N`，鼠标悬浮 /
 *    键盘聚焦时展开为列表查看全部、并可点击跟随。
 *
 * 自己（SESSION.clientId）单独标识在第一位，「你」chip 不可点。
 */
import { useSyncExternalStore } from 'react';
import { presenceStore, type RemotePresence } from './presenceStore';
import { followStore } from './followStore';
import { SESSION, resolveIdentity } from '../session';
import './presence.css';

/** 直接显示的在场者上限（不含「你」）—— 多于此收进 `+N` 折叠。 */
const MAX_VISIBLE = 3;

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

  // 排序：其余按 ts（最早入场先）。presenceStore 内部排序不稳定，这里显式排
  // 一遍保 UI 稳定。
  const liveOthers = users
    .filter((u) => u.clientId !== SESSION.clientId)
    .sort((a, b) => a.ts - b.ts);

  // 「你」chip 的显示名 / 配色与上报一致 —— 按在线真人集合协调（与 PresenceLayer
  // 同一套 resolveIdentity，故和别人看到的「我」一致、不撞名）。
  const selfIdentity = resolveIdentity(
    SESSION.clientId,
    liveOthers.filter((u) => !u.isAgent).map((u) => u.clientId),
  );

  const visible = liveOthers.slice(0, MAX_VISIBLE);
  const hidden = liveOthers.slice(MAX_VISIBLE);

  // 单个可跟随的在场者 chip —— 顶栏直显（variant='chip'）与折叠列表（'row'）共用。
  const renderPeerChip = (
    u: RemotePresence,
    variant: 'chip' | 'row',
  ): JSX.Element => {
    const isFollowed = followingId === u.clientId;
    const isAgent = !!u.isAgent;
    return (
      <button
        key={u.clientId}
        type="button"
        className={
          (variant === 'row'
            ? 'presence-bar__row'
            : 'presence-bar__chip presence-bar__chip--clickable') +
          (isFollowed ? ' presence-bar__chip--followed' : '') +
          (isAgent ? ' presence-bar__chip--agent' : '')
        }
        onClick={() =>
          followStore.setFollowing(isFollowed ? null : u.clientId)
        }
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
  };

  // 无对端在场时仍显示「自己」chip —— 让人知道连接是通的，独人状态明确。
  return (
    <div className="presence-bar" role="group" aria-label="在线参与者">
      <span
        className="presence-bar__chip presence-bar__chip--self"
        title={`你（${selfIdentity.name}）`}
      >
        <span
          className="presence-bar__avatar"
          style={{ background: selfIdentity.color }}
          aria-hidden="true"
        >
          {initial(selfIdentity.name)}
        </span>
        <span className="presence-bar__name">你</span>
      </span>
      {visible.map((u) => renderPeerChip(u, 'chip'))}
      {hidden.length > 0 ? (
        <div className="presence-bar__more">
          <button
            type="button"
            className="presence-bar__overflow"
            aria-haspopup="menu"
            title={`还有 ${hidden.length} 位在场参与者 —— 悬浮查看`}
          >
            +{hidden.length}
          </button>
          {/* hover / focus-within 展开 —— 列出折叠的在场者，可点击跟随。 */}
          <div className="presence-bar__more-pop" role="menu">
            {hidden.map((u) => renderPeerChip(u, 'row'))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
