/**
 * 自研画布层 —— 画布外壳（增量2）。
 *
 * 把「覆盖层」升级为「主画布」：外壳自己持有视口、处理平移 / 缩放手势、画网格、
 * 摆工具栏与缩放控件。Excalidraw 退居为外壳内的一个被动渲染器（仍画 draw/shape，
 * 见 BoardCanvas）—— 视口由外壳下发，Excalidraw 自有工具栏与平移让位给外壳。
 *
 * 层叠（自下而上）：
 *   cv-shell（暖色底 + 手势）→ 网格 → BoardCanvas（Excalidraw + 覆盖层 + 在场层）
 *   → 工具栏 / 缩放控件
 *
 * 视口真相源在本组件的 `viewport` state。两个写入方：
 *  - 本组件的手势 hook（滚轮 / 中键）；
 *  - BoardCanvas 上传的 Excalidraw 自身视口变化（抓手平移 / 导入聚焦等）。
 * 增量3 拆掉 Excalidraw 后，本 state 即画布唯一视口。
 */
import { useCallback, useRef, useState } from 'react';
import { BoardCanvas } from '../components/BoardCanvas';
import { CanvasGrid } from './CanvasGrid';
import { Toolbar } from './Toolbar';
import { useViewportGestures } from './useViewportGestures';
import { INITIAL_VIEWPORT, zoomAt, type CanvasViewport } from './viewport';
import './canvas.css';

/** 缩放控件每次点击的缩放倍率。 */
const ZOOM_STEP = 1.2;

/** 画布外壳。 */
export function CanvasShell(): JSX.Element {
  // 视口真相源。
  const [viewport, setViewport] = useState<CanvasViewport>(INITIAL_VIEWPORT);
  // 当前工具 —— 由工具栏选择，下发给 BoardCanvas 同步到 Excalidraw。
  const [activeTool, setActiveTool] = useState<string>('selection');
  const shellRef = useRef<HTMLDivElement>(null);

  const { panning } = useViewportGestures({
    surfaceRef: shellRef,
    viewport,
    onChange: setViewport,
  });

  // 缩放控件 —— 以外壳中心为锚缩放。
  const zoomBy = useCallback((factor: number) => {
    const el = shellRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setViewport((vp) => zoomAt(vp, vp.zoom * factor, r.width / 2, r.height / 2));
  }, []);
  const resetZoom = useCallback(() => {
    const el = shellRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setViewport((vp) => zoomAt(vp, 1, r.width / 2, r.height / 2));
  }, []);

  return (
    <div
      className={'cv-shell' + (panning ? ' cv-shell--panning' : '')}
      ref={shellRef}
    >
      <CanvasGrid viewport={viewport} />
      <BoardCanvas
        viewport={viewport}
        onViewportChange={setViewport}
        activeTool={activeTool}
        onActiveToolChange={setActiveTool}
      />
      <Toolbar activeTool={activeTool} onSelect={setActiveTool} />
      <div className="cv-zoom" role="group" aria-label="缩放">
        <button
          type="button"
          className="cv-zoom__btn"
          onClick={() => zoomBy(1 / ZOOM_STEP)}
          title="缩小"
          aria-label="缩小"
        >
          −
        </button>
        <button
          type="button"
          className="cv-zoom__pct"
          onClick={resetZoom}
          title="重置为 100%"
          aria-label="重置缩放为 100%"
        >
          {Math.round(viewport.zoom * 100)}%
        </button>
        <button
          type="button"
          className="cv-zoom__btn"
          onClick={() => zoomBy(ZOOM_STEP)}
          title="放大"
          aria-label="放大"
        >
          +
        </button>
      </div>
    </div>
  );
}
