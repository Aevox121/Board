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
import { computeEditAnchor } from '@board/core';
import { SESSION, resolveIdentity } from '../session';
import { sendPresence } from '../server/client';
import { presenceStore } from './presenceStore';
import { useBoard } from '../board/BoardContext';
import { useZoomBucket, viewportStore } from '../canvas/viewportStore';
import './presence.css';

/** 光标上报节流间隔（毫秒）。 */
const THROTTLE_MS = 90;
/** 心跳间隔（毫秒）—— 静止时也保活，避免被 server 判离线。 */
const HEARTBEAT_MS = 4000;

export interface PresenceLayerProps {
  /**
   * 点击对端光标 / 名牌时回调（PRD §8.2 跟随视角入口）。CanvasShell 据此
   * 切换 followingClientId；不传则名牌不响应点击（保持原 pointer-events:none）。
   */
  onFollowClient?: (clientId: string) => void;
}

/** 在场光标层。 */
export function PresenceLayer({
  onFollowClient,
}: PresenceLayerProps): JSX.Element {
  const users = useSyncExternalStore(
    presenceStore.subscribe,
    presenceStore.getSnapshot,
  );
  const { scene } = useBoard();
  // 给 Agent 轨道光标用 —— Agent 的 targetElementId 解析为 bbox
  const elementById = new Map(scene.elements.map((e) => [e.id, e]));
  const rootRef = useRef<HTMLDivElement>(null);
  // 光标容器注册为 viewportStore 的 transform 容器 —— 平移/缩放时由 store 直接
  // mutate 它的 transform（与 .ov-transform 用同一套变换串、完全同步），不经
  // React。故平移整画板时对端光标随容器一起 GPU 平移、不再每帧 React 重渲算
  // 屏幕坐标，消除「他人光标抽搐」。
  const viewportElRef = useRef<HTMLDivElement>(null);
  useEffect(() => viewportStore.registerTransformEl(viewportElRef.current), []);
  // 只订阅「缩放档」（5% 一跳）—— 用于光标内容的反向缩放 1/zoom，保持屏幕恒定
  // 大小。平移不改 zoom 故不触发本组件重渲；缩放按档更新（档间 ≤5% 误差，
  // 手势停下即精确）。
  useZoomBucket();
  const invZoom = 1 / viewportStore.get().zoom;

  // ── 本端光标上报：鼠标移动节流 + 心跳 + 离开 ──────────────────
  useEffect(() => {
    let lastCursor: { x: number; y: number } | null = null;
    let lastSent = 0;
    let trailing: number | undefined;

    const post = (cursor: { x: number; y: number } | null): void => {
      // viewport（PRD §8.2 跟随视角）—— 视口左上角的画布坐标 + zoom；
      // 受让方按此对齐自己的视口。
      const { scrollX, scrollY, zoom } = viewportStore.get();
      // 显示名 / 配色按「当前在线真人集合」协调得出 —— 各端确定性算法一致，
      // 不会撞名（Agent 自带名字、不参与，故按 !isAgent 过滤）。
      const humanIds = presenceStore
        .getSnapshot()
        .filter((p) => p.clientId !== SESSION.clientId && !p.isAgent)
        .map((p) => p.clientId);
      const me = resolveIdentity(SESSION.clientId, humanIds);
      void sendPresence({
        clientId: SESSION.clientId,
        name: me.name,
        color: me.color,
        cursor,
        viewport: { x: -scrollX, y: -scrollY, zoom },
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
      const { scrollX, scrollY, zoom } = viewportStore.get();
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
  // 位置全部用「画布坐标」，由外层 .presence-viewport 的 transform 统一换算到屏幕
  // （和 .ov-transform 同步）；光标本体 / 名牌按 invZoom 反向缩放，保持屏幕恒定大小。
  const arrowPath =
    'M5 3 L5 19 L9.6 14.7 L12.6 21 L15.2 19.8 L12.2 13.6 L18.4 13.6 Z';
  return (
    <div className="presence-layer" ref={rootRef}>
      <div className="presence-viewport" ref={viewportElRef}>
        {users.map((u) => {
          if (u.clientId === SESSION.clientId) return null;
          // Agent 轨道光标 —— targetElementId 命中场景元素时，围绕该元素 bbox 运动
          if (u.targetElementId) {
            const target = elementById.get(u.targetElementId);
            if (!target) return null; // 找不到目标 —— 等下一帧 / 目标出现
            // Agent 焦点点 = element 本地坐标的 targetOffset；缺省由 core 的
            // computeEditAnchor 据元素类型算。结果是「画布坐标」，交给容器变换。
            const offset = u.targetOffset ?? computeEditAnchor(target);
            const cx = target.x + offset.x;
            const cy = target.y + offset.y;
            // 让不同 client 的 jitter 不同步 —— 给每个 cursor 一个独立 phase
            // delay（基于 clientId 简单哈希）。
            let phase = 0;
            for (let i = 0; i < u.clientId.length; i += 1) {
              phase = (phase * 31 + u.clientId.charCodeAt(i)) >>> 0;
            }
            const phaseSec = -((phase % 5000) / 1000); // 负值让 phase 在过去
            return (
              <div
                key={u.clientId}
                className="presence-focus"
                style={{ transform: `translate(${cx}px, ${cy}px)` }}
              >
                <div
                  className="presence-focus__scale"
                  style={{ transform: `scale(${invZoom})` }}
                >
                  <div
                    className="presence-focus__cursor"
                    style={{
                      ['--c' as string]: u.color,
                      ['--jitter-phase' as string]: `${phaseSec.toFixed(2)}s`,
                    }}
                  >
                    <svg viewBox="0 0 24 24" width="22" height="22">
                      <path
                        d={arrowPath}
                        fill={u.color}
                        stroke="#ffffff"
                        strokeWidth="1.4"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <span
                      className={
                        'presence-focus__name' +
                        (onFollowClient ? ' presence-name--clickable' : '')
                      }
                      style={{ background: u.color }}
                      onClick={
                        onFollowClient
                          ? (e) => {
                              e.stopPropagation();
                              onFollowClient(u.clientId);
                            }
                          : undefined
                      }
                      title={onFollowClient ? `跟随 ${u.name} 视角` : undefined}
                    >
                      ◆ {u.name}
                    </span>
                  </div>
                </div>
              </div>
            );
          }
          // 普通人类光标 —— 静态箭头
          if (!u.cursor) return null;
          return (
            <div
              key={u.clientId}
              className="presence-cursor"
              style={{ transform: `translate(${u.cursor.x}px, ${u.cursor.y}px)` }}
            >
              <div
                className="presence-cursor__inner"
                style={{ transform: `scale(${invZoom})` }}
              >
                <svg
                  className="presence-arrow"
                  viewBox="0 0 24 24"
                  width="22"
                  height="22"
                >
                  <path
                    d={arrowPath}
                    fill={u.color}
                    stroke="#ffffff"
                    strokeWidth="1.4"
                    strokeLinejoin="round"
                  />
                </svg>
                <span
                  className={
                    'presence-name' +
                    (onFollowClient ? ' presence-name--clickable' : '')
                  }
                  style={{ background: u.color }}
                  onClick={
                    onFollowClient
                      ? (e) => {
                          e.stopPropagation();
                          onFollowClient(u.clientId);
                        }
                      : undefined
                  }
                  title={onFollowClient ? `跟随 ${u.name} 视角` : undefined}
                >
                  {u.name}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
