/**
 * 画布区 —— 挂载 Excalidraw，并把它与白板状态层（useBoard）双向桥接。
 *
 * 数据流：
 *  - 用户在画布上操作 → Excalidraw `onChange` → 桥接为 core 场景 → `replaceScene(...,'canvas')`。
 *  - 导入 board.json → `importTick` 自增 → 本组件用 `updateScene` 把 core 场景推进 Excalidraw。
 *
 * 防回环：`updateScene` 会再次触发 `onChange`，用 `suppressNextChange` 标志吞掉
 * 紧随程序化更新之后的那次回调，避免「导入 → onChange → 再写回」的多余循环。
 */
import { useCallback, useEffect, useRef } from 'react';
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
import './BoardCanvas.css';

export function BoardCanvas(): JSX.Element {
  const { scene, actorId, replaceScene, importTick } = useBoard();
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);

  // 始终持有最新场景，供 onChange 闭包做 id 对齐（保留 z/parentId 等）。
  const sceneRef = useRef(scene);
  sceneRef.current = scene;

  // true 时吞掉下一次 onChange（它由程序化 updateScene 引发，非用户操作）。
  const suppressNextChange = useRef(false);

  /** Excalidraw 元素 / 视口变化 → 写回 core 场景。 */
  const handleChange = useCallback(
    (elements: readonly ExcalidrawElement[], appState: AppState) => {
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
      <Excalidraw
        excalidrawAPI={(api) => {
          apiRef.current = api;
        }}
        onChange={handleChange}
      />
    </div>
  );
}
