/**
 * 自研画布层 —— 画布外壳（增量2 建立，增量3 接管全部渲染）。
 *
 * 增量3「大切换」后，Excalidraw 已从渲染树移除：画布外壳直接挂载覆盖层
 * （OverlayLayer 渲染全部 10 类元素，含图形 / 手绘）与在场层，没有中间桥。
 *
 * 层叠（自下而上）：
 *   cv-shell（暖色底 + 平移/缩放手势）→ 网格 → board-canvas（覆盖层 + 在场层）
 *   → 工具栏 / 缩放控件
 *
 * 视口真相源在本组件的 `viewport` state，由平移/缩放手势与缩放控件写入；
 * 导入 / 首次连接时由 fitToContent 聚焦到全部内容。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useBoard } from '../board/BoardContext';
import { OverlayLayer } from '../overlay/OverlayLayer';
import { PresenceLayer } from '../presence/PresenceLayer';
import { CanvasGrid } from './CanvasGrid';
import { Toolbar } from './Toolbar';
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
  const { scene, importTick, importFit } = useBoard();
  // 视口真相源。
  const [viewport, setViewport] = useState<CanvasViewport>(INITIAL_VIEWPORT);
  // 当前工具 —— 由工具栏选择，覆盖层据此切换连线 / 橡皮擦模式。
  const [activeTool, setActiveTool] = useState<string>('selection');
  const shellRef = useRef<HTMLDivElement>(null);

  const { panning } = useViewportGestures({
    surfaceRef: shellRef,
    viewport,
    onChange: setViewport,
  });

  // 导入 / 首次连接（importTick 自增且 importFit）：把视口聚焦到全部内容。
  // fittedTickRef 保证每个 importTick 只聚焦一次。
  const fittedTickRef = useRef(0);
  useEffect(() => {
    if (importTick === 0 || !importFit) return;
    if (importTick === fittedTickRef.current) return;
    fittedTickRef.current = importTick;
    const el = shellRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setViewport(fitToContent(scene.elements, r.width, r.height));
  }, [importTick, importFit, scene]);

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
      <div className="board-canvas">
        <OverlayLayer
          scene={scene}
          viewport={viewport}
          activeTool={activeTool}
          onActiveToolChange={setActiveTool}
        />
        <PresenceLayer viewport={viewport} />
      </div>
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
