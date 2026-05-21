/**
 * 在场光标层（M4：拟人化光标，PRD §8.2）。
 *
 * 两件事：
 *  - 上报本端光标 —— 监听鼠标移动，换算为画布坐标，节流后 POST /api/presence；
 *    另有 4s 心跳保活、tab 关闭时 sendBeacon 显式离开。
 *  - 渲染对端光标 —— 从 presenceStore 取在场列表，按本端视口把每个对端的
 *    画布坐标光标换算到屏幕位置，画成带名牌的彩色箭头。
 *
 * 本层 `pointer-events:none`，纯展示，不拦截画布交互。光标位置以画布坐标
 * 传输，故各端缩放 / 平移不同也能正确对位。
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { SESSION } from '../session';
import { sendPresence } from '../server/client';
import { presenceStore } from './presenceStore';
import type { OverlayViewport } from '../overlay/OverlayLayer';
import './presence.css';

/** 光标上报节流间隔（毫秒）。 */
const THROTTLE_MS = 90;
/** 心跳间隔（毫秒）—— 静止时也保活，避免被 server 判离线。 */
const HEARTBEAT_MS = 4000;

export interface PresenceLayerProps {
  /** 与覆盖层共享的视口（scrollX / scrollY / zoom）。 */
  viewport: OverlayViewport;
}

/** 在场光标层。 */
export function PresenceLayer({ viewport }: PresenceLayerProps): JSX.Element {
  const users = useSyncExternalStore(
    presenceStore.subscribe,
    presenceStore.getSnapshot,
  );
  const rootRef = useRef<HTMLDivElement>(null);
  // 视口随平移 / 缩放变化，用 ref 让上报回调读到最新值。
  const vpRef = useRef(viewport);
  vpRef.current = viewport;

  // ── 本端光标上报：鼠标移动节流 + 心跳 + 离开 ──────────────────
  useEffect(() => {
    let lastCursor: { x: number; y: number } | null = null;
    let lastSent = 0;
    let trailing: number | undefined;

    const post = (cursor: { x: number; y: number } | null): void => {
      void sendPresence({
        clientId: SESSION.clientId,
        name: SESSION.name,
        color: SESSION.color,
        cursor,
      });
    };
    const flush = (): void => {
      lastSent = Date.now();
      trailing = undefined;
      post(lastCursor);
    };
    const onMove = (e: MouseEvent): void => {
      const root = rootRef.current;
      if (!root) return;
      const r = root.getBoundingClientRect();
      // 鼠标不在画布区域内 —— 不上报。
      if (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      ) {
        return;
      }
      const { scrollX, scrollY, zoom } = vpRef.current;
      // 屏幕坐标 → 画布坐标（screen = (canvas + scroll) * zoom 的逆）。
      lastCursor = {
        x: (e.clientX - r.left) / zoom - scrollX,
        y: (e.clientY - r.top) / zoom - scrollY,
      };
      const wait = THROTTLE_MS - (Date.now() - lastSent);
      if (wait <= 0) flush();
      else if (trailing === undefined) trailing = window.setTimeout(flush, wait);
    };
    const leave = (): void => {
      // sendBeacon 在 tab 关闭 / 页面卸载时仍能送达。pagehide 比 beforeunload
      // 更可靠（移动端 / 后台标签页也触发），两者都挂、server 端幂等。
      navigator.sendBeacon?.(
        '/api/presence',
        new Blob(
          [JSON.stringify({ clientId: SESSION.clientId, leaving: true })],
          { type: 'application/json' },
        ),
      );
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('pagehide', leave);
    window.addEventListener('beforeunload', leave);
    const hb = window.setInterval(() => post(lastCursor), HEARTBEAT_MS);
    post(null); // 初次在场宣告（光标位置未知）

    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('pagehide', leave);
      window.removeEventListener('beforeunload', leave);
      window.clearInterval(hb);
      if (trailing !== undefined) window.clearTimeout(trailing);
      leave();
    };
  }, []);

  // ── 渲染对端光标 ─────────────────────────────────────────────
  const { scrollX, scrollY, zoom } = viewport;
  return (
    <div className="presence-layer" ref={rootRef}>
      {users.map((u) =>
        u.clientId === SESSION.clientId || !u.cursor ? null : (
          <div
            key={u.clientId}
            className="presence-cursor"
            style={{
              transform: `translate(${(u.cursor.x + scrollX) * zoom}px, ${
                (u.cursor.y + scrollY) * zoom
              }px)`,
            }}
          >
            <svg
              className="presence-arrow"
              viewBox="0 0 24 24"
              width="22"
              height="22"
            >
              <path
                d="M5 3 L5 19 L9.6 14.7 L12.6 21 L15.2 19.8 L12.2 13.6 L18.4 13.6 Z"
                fill={u.color}
                stroke="#ffffff"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
            </svg>
            <span className="presence-name" style={{ background: u.color }}>
              {u.name}
            </span>
          </div>
        ),
      )}
    </div>
  );
}
