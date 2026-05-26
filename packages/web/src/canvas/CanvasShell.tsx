/**
 * 自研画布层 —— 画布外壳（增量2 建立，增量3 接管全部渲染）。
 *
 * Excalidraw 已从渲染树移除：画布外壳直接挂载覆盖层（OverlayLayer 渲染全部
 * 10 类元素，含图形 / 手绘）与在场层，没有中间桥。
 *
 * 层叠（自下而上）：
 *   cv-shell（暖色底 + 平移/缩放手势）→ 网格 → board-canvas（覆盖层 + 在场层）
 *   → 工具栏 / 底部控件（撤销重做 + 缩放）
 *
 * 视口真相源在本组件的 `viewport` state，由平移/缩放手势与缩放控件写入；
 * 导入 / 首次连接时由 fitToContent 聚焦到全部内容。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useBoard } from '../board/BoardContext';
import { OverlayLayer } from '../overlay/OverlayLayer';
import { PresenceLayer } from '../presence/PresenceLayer';
import { presenceStore } from '../presence/presenceStore';
import { followStore } from '../presence/followStore';
import { SESSION } from '../session';
import { CanvasGrid } from './CanvasGrid';
import { Toolbar, TOOL_SHORTCUTS } from './Toolbar';
import { Minimap } from './Minimap';
import { useViewportGestures } from './useViewportGestures';
import {
  INITIAL_VIEWPORT,
  fitToContent,
  zoomAt,
  type CanvasViewport,
} from './viewport';
import './canvas.css';

/** 缩放控件每次点击的缩放倍率。 */
const ZOOM_STEP = 1.2;

/** 画布外壳。 */
export function CanvasShell(): JSX.Element {
  const {
    scene,
    importTick,
    importFit,
    navTick,
    navTargetId,
    undo,
    redo,
    canUndo,
    canRedo,
  } = useBoard();
  // 视口真相源。
  const [viewport, setViewport] = useState<CanvasViewport>(INITIAL_VIEWPORT);
  // 当前工具 —— 由工具栏选择，覆盖层据此进入创建 / 连线 / 橡皮擦模式。
  const [activeTool, setActiveTool] = useState<string>('selection');
  const shellRef = useRef<HTMLDivElement>(null);

  // ── 跟随视角（PRD §8.2）─────────────────────────────────────
  // followingClientId 不为 null 时，本端视口受 followingClientId 对应 presence
  // 的 viewport 拉扯；任意本地交互（平移 / 缩放 / 导航 / fit）一律退出跟随，
  // 把控制权交还给用户。state 提到 followStore，便于 TopBar 在线参与者条
  // 也能读 / 设（PresenceLayer 名牌 + TopBar 头像走同一份真相）。
  const followingClientId = useSyncExternalStore(
    followStore.subscribe,
    followStore.getSnapshot,
  );
  const presenceUsers = useSyncExternalStore(
    presenceStore.subscribe,
    presenceStore.getSnapshot,
  );
  const followed =
    followingClientId !== null
      ? presenceUsers.find((u) => u.clientId === followingClientId)
      : null;

  /**
   * 本地交互专用的 viewport setter —— 凡用户手动改动视口都走这条，自动退出
   * 跟随；跟随驱动的视口对齐则直接 setViewport，不触发退出。
   */
  const setViewportLocal = useCallback(
    (updater: CanvasViewport | ((vp: CanvasViewport) => CanvasViewport)) => {
      followStore.setFollowing(null);
      setViewport(updater);
    },
    [],
  );

  const { panning } = useViewportGestures({
    surfaceRef: shellRef,
    viewport,
    onChange: setViewportLocal,
  });

  // 跟随驱动 —— followed.viewport 变化即把本端视口对齐过去。
  useEffect(() => {
    if (!followingClientId) return;
    if (!followed || !followed.viewport) return;
    const { x, y, zoom } = followed.viewport;
    setViewport({ scrollX: -x, scrollY: -y, zoom });
  }, [followingClientId, followed]);

  // 被跟随者下线 / 不再上报 → 自动退出跟随。
  useEffect(() => {
    if (!followingClientId) return;
    if (!followed) followStore.setFollowing(null);
  }, [followingClientId, followed]);

  // 点远端徽标 → 切换跟随：
  //  - 当前未跟随 → 跟随该人
  //  - 当前已跟随同一人 → 退出
  //  - 已跟随另一人 → 改跟随这一人
  const onFollowClient = useCallback((clientId: string) => {
    if (clientId === SESSION.clientId) return;
    const cur = followStore.getSnapshot();
    followStore.setFollowing(cur === clientId ? null : clientId);
  }, []);

  // 导入 / 首次连接（importTick 自增且 importFit）：把视口聚焦到全部内容。
  // fittedTickRef 保证每个 importTick 只聚焦一次。
  //
  // 关键时序：fetchBoard (HTTP) 触发 loadFromServer('initial') 设 fit=true 时，
  // Y.Doc (ws) 可能尚未把 elements 同步过来 —— 此刻 scene.elements 还是 []，
  // fitToContent([]) 退回 INITIAL_VIEWPORT 且会标记本 tick 已 fit，后续 Y.Doc
  // 元素到位时再次触发本 effect 也被跳过。故加 elements.length>0 守门：
  // 元素未到就不算 fit 过，等元素同步进来后再 fit 一次。空 board 永不 fit
  // —— 没内容也无可适配。
  const fittedTickRef = useRef(0);
  useEffect(() => {
    if (importTick === 0 || !importFit) return;
    if (importTick === fittedTickRef.current) return;
    if (scene.elements.length === 0) return;
    fittedTickRef.current = importTick;
    const el = shellRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setViewportLocal(fitToContent(scene.elements, r.width, r.height));
  }, [importTick, importFit, scene, setViewportLocal]);

  // 「导航请求」—— OutlinePanel / 搜索结果点击元素时把视口居中到该元素。
  // navTick 每次自增即响应一次（同一元素可重复跳转）。
  const navTickRef = useRef(0);
  useEffect(() => {
    if (navTick === 0 || navTick === navTickRef.current) return;
    navTickRef.current = navTick;
    if (!navTargetId) return;
    const target = scene.elements.find((e) => e.id === navTargetId);
    if (!target) return;
    const sh = shellRef.current;
    if (!sh) return;
    const r = sh.getBoundingClientRect();
    const cx = target.x + target.width / 2;
    const cy = target.y + target.height / 2;
    setViewportLocal((vp) => ({
      scrollX: r.width / 2 / vp.zoom - cx,
      scrollY: r.height / 2 / vp.zoom - cy,
      zoom: vp.zoom,
    }));
  }, [navTick, navTargetId, scene, setViewportLocal]);

  // 撤销 / 重做快捷键 —— Ctrl/⌘+Z 撤销，Ctrl/⌘+Shift+Z 或 Ctrl/⌘+Y 重做。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k !== 'z' && k !== 'y') return;
      // 输入框 / 文本域聚焦时让位给原生撤销。
      const ae = document.activeElement as HTMLElement | null;
      if (
        ae &&
        (ae.tagName === 'INPUT' ||
          ae.tagName === 'TEXTAREA' ||
          ae.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      if (k === 'y' || (k === 'z' && e.shiftKey)) redo();
      else undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  // 工具快捷键 —— 无修饰键的字母 / 数字键切换工具（V/R/O/D/A/P/T/E 或 1-8），
  // Esc 回到选择工具。输入框 / 文本域聚焦时让位给原生输入。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const ae = document.activeElement as HTMLElement | null;
      if (
        ae &&
        (ae.tagName === 'INPUT' ||
          ae.tagName === 'TEXTAREA' ||
          ae.isContentEditable)
      ) {
        return;
      }
      if (e.key === 'Escape') {
        setActiveTool('selection');
        return;
      }
      const tool = TOOL_SHORTCUTS[e.key.toLowerCase()];
      if (tool) {
        e.preventDefault();
        setActiveTool(tool);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 缩放控件 —— 以外壳中心为锚缩放。本地交互，触发跟随退出。
  const zoomBy = useCallback(
    (factor: number) => {
      const el = shellRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setViewportLocal((vp) =>
        zoomAt(vp, vp.zoom * factor, r.width / 2, r.height / 2),
      );
    },
    [setViewportLocal],
  );
  const resetZoom = useCallback(() => {
    const el = shellRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setViewportLocal((vp) => zoomAt(vp, 1, r.width / 2, r.height / 2));
  }, [setViewportLocal]);
  // 「回到全部内容」按钮 + 快捷键 —— 把视口聚焦到当前所有元素（fitToContent）。
  const fitAll = useCallback(() => {
    const el = shellRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setViewportLocal(fitToContent(scene.elements, r.width, r.height));
  }, [scene.elements, setViewportLocal]);
  // 小地图点击 —— 把指定的画布坐标置于视口中心。
  const jumpToCanvasPoint = useCallback(
    (cx: number, cy: number) => {
      const el = shellRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setViewportLocal((vp) => ({
        scrollX: r.width / 2 / vp.zoom - cx,
        scrollY: r.height / 2 / vp.zoom - cy,
        zoom: vp.zoom,
      }));
    },
    [setViewportLocal],
  );
  // 「适配选中」—— 但选区由 OverlayLayer 持有，目前没向上暴露；先不做按钮，
  // 仅留 fitAll，「适配选中」放后续。

  return (
    <div
      className={'cv-shell' + (panning ? ' cv-shell--panning' : '')}
      ref={shellRef}
    >
      <CanvasGrid viewport={viewport} />
      <div className="board-canvas">
        <OverlayLayer
          scene={scene}
          viewport={viewport}
          activeTool={activeTool}
          onActiveToolChange={setActiveTool}
        />
        <PresenceLayer viewport={viewport} onFollowClient={onFollowClient} />
      </div>
      {followed ? (
        <div
          className="cv-follow-banner"
          role="status"
          style={
            { ['--c-followed' as string]: followed.color } as React.CSSProperties
          }
        >
          <span className="cv-follow-banner__dot" aria-hidden="true" />
          <span>
            正在跟随 <strong>{followed.name}</strong> 的视角
          </span>
          <button
            type="button"
            className="cv-follow-banner__exit"
            onClick={() => followStore.setFollowing(null)}
            title="退出跟随（任何画布操作也会退出）"
          >
            退出
          </button>
        </div>
      ) : null}
      <Toolbar activeTool={activeTool} onSelect={setActiveTool} />
      <Minimap
        elements={scene.elements}
        viewport={viewport}
        getViewSize={() => {
          const el = shellRef.current;
          if (!el) return { width: 0, height: 0 };
          const r = el.getBoundingClientRect();
          return { width: r.width, height: r.height };
        }}
        onJump={jumpToCanvasPoint}
      />
      <div className="cv-bottombar">
        <div className="cv-pill" role="group" aria-label="撤销重做">
          <button
            type="button"
            className="cv-pill__btn"
            onClick={undo}
            disabled={!canUndo}
            title="撤销 (Ctrl+Z)"
            aria-label="撤销"
          >
            ↶
          </button>
          <button
            type="button"
            className="cv-pill__btn"
            onClick={redo}
            disabled={!canRedo}
            title="重做 (Ctrl+Shift+Z)"
            aria-label="重做"
          >
            ↷
          </button>
        </div>
        <div className="cv-pill" role="group" aria-label="缩放">
          <button
            type="button"
            className="cv-pill__btn"
            onClick={() => zoomBy(1 / ZOOM_STEP)}
            title="缩小"
            aria-label="缩小"
          >
            −
          </button>
          <button
            type="button"
            className="cv-pill__pct"
            onClick={resetZoom}
            title="重置为 100%"
            aria-label="重置缩放为 100%"
          >
            {Math.round(viewport.zoom * 100)}%
          </button>
          <button
            type="button"
            className="cv-pill__btn"
            onClick={() => zoomBy(ZOOM_STEP)}
            title="放大"
            aria-label="放大"
          >
            +
          </button>
          <button
            type="button"
            className="cv-pill__btn"
            onClick={fitAll}
            disabled={scene.elements.length === 0}
            title="回到全部内容（聚焦到所有元素）"
            aria-label="回到全部内容"
          >
            ⊡
          </button>
        </div>
      </div>
    </div>
  );
}
