/**
 * 画布区 —— 挂载 Excalidraw，并把它与白板状态层（useBoard）双向桥接。
 *
 * 数据流：
 *  - 用户在画布上操作 → Excalidraw `onChange` → 桥接为 core 场景 → `replaceScene(...,'canvas')`。
 *  - 导入 board.json → `importTick` 自增 → 本组件用 `updateScene` 把 core 场景推进 Excalidraw。
 *
 * 防回环：`updateScene` 会再次触发 `onChange`，用 `suppressNextChange` 标志吞掉
 * 紧随程序化更新之后的那次回调，避免「导入 → onChange → 再写回」的多余循环。
 *
 * DOM 覆盖层（M2）：
 *  - 在 Excalidraw 之上叠一层 `OverlayLayer`，渲染 file/folder/region 内容元素。
 *  - 覆盖层与画布共享坐标系 —— 其视口 (scrollX/scrollY/zoom) 取自同一份
 *    Excalidraw `onChange` 的 appState，平移/缩放时实时跟随。
 *  - 视口存为本组件 state，每次 onChange 重算；suppressNextChange 吞掉的那次
 *    （程序化 updateScene 引发）也照常更新视口，保证导入后覆盖层立即对齐。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Excalidraw } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types';
import type { AppState } from '@excalidraw/excalidraw/types/types';
import { useBoard } from '../board/BoardContext';
import {
  excalidrawToScene,
  sceneToExcalidraw,
  type ExViewportState,
} from '../bridge';
import { OverlayLayer, type OverlayViewport } from '../overlay/OverlayLayer';
import './BoardCanvas.css';

/** 覆盖层初始视口 —— 与 createBoardScene 的默认 viewport 对齐。 */
const INITIAL_VIEWPORT: OverlayViewport = { scrollX: 0, scrollY: 0, zoom: 1 };

export function BoardCanvas(): JSX.Element {
  const { scene, actorId, replaceScene, importTick } = useBoard();
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);

  // 始终持有最新场景，供 onChange 闭包做 id 对齐（保留 z/parentId 等）。
  const sceneRef = useRef(scene);
  sceneRef.current = scene;

  // true 时吞掉下一次 onChange 对场景的写回（它由程序化 updateScene 引发）。
  // 注意：视口仍照常更新 —— 程序化更新也会改 scrollX/scrollY/zoom。
  const suppressNextChange = useRef(false);

  // 覆盖层视口 —— 与画布共享坐标系，每次 onChange 从 appState 重算。
  const [overlayViewport, setOverlayViewport] =
    useState<OverlayViewport>(INITIAL_VIEWPORT);

  /**
   * 稳定的 Excalidraw API 回调。必须 useCallback：
   * 内联函数每次渲染都是新引用，会让 Excalidraw 反复重新初始化，
   * 与 onChange → 场景写回 → 重渲染 形成无限渲染循环。
   */
  const handleApi = useCallback((api: ExcalidrawImperativeAPI) => {
    apiRef.current = api;
  }, []);

  /** Excalidraw 元素 / 视口变化 → 写回 core 场景 + 同步覆盖层视口。 */
  const handleChange = useCallback(
    (elements: readonly ExcalidrawElement[], appState: AppState) => {
      // 视口始终跟随：即便本次 onChange 由程序化更新引发，也要让覆盖层对齐。
      setOverlayViewport((prev) => {
        const next: OverlayViewport = {
          scrollX: appState.scrollX,
          scrollY: appState.scrollY,
          zoom: appState.zoom.value,
        };
        // 视口未变则复用旧对象，避免无谓重渲染。
        if (
          prev.scrollX === next.scrollX &&
          prev.scrollY === next.scrollY &&
          prev.zoom === next.zoom
        ) {
          return prev;
        }
        return next;
      });

      if (suppressNextChange.current) {
        suppressNextChange.current = false;
        return;
      }
      const viewport: ExViewportState = {
        scrollX: appState.scrollX,
        scrollY: appState.scrollY,
        zoom: { value: appState.zoom.value },
      };
      const next = excalidrawToScene(
        elements,
        viewport,
        actorId,
        sceneRef.current,
      );
      replaceScene(next, 'canvas');
    },
    [actorId, replaceScene],
  );

  // 导入发生时（importTick 变化）：把内存场景推进 Excalidraw。
  useEffect(() => {
    if (importTick === 0) return; // 初始空场景无需推送
    const api = apiRef.current;
    if (!api) return;
    const { elements, appState } = sceneToExcalidraw(sceneRef.current);
    suppressNextChange.current = true;
    api.updateScene({
      elements,
      appState: {
        scrollX: appState.scrollX,
        scrollY: appState.scrollY,
        zoom: { value: appState.zoom.value as AppState['zoom']['value'] },
      },
    });
    // 导入后视图聚焦到全部内容，方便用户立即看到导入结果。
    if (elements.length > 0) {
      api.scrollToContent(elements, { fitToContent: true });
    }
  }, [importTick]);

  return (
    <div className="board-canvas">
      <Excalidraw excalidrawAPI={handleApi} onChange={handleChange} />
      {/* DOM 覆盖层 —— 叠在 Excalidraw 之上，渲染 file/folder/region 内容元素 */}
      <OverlayLayer scene={scene} viewport={overlayViewport} />
    </div>
  );
}
