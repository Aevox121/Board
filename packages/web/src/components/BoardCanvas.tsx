/**
 * 画布渲染器 —— 挂载 Excalidraw，并把它与白板状态层（useBoard）双向桥接。
 *
 * 自研画布层（增量2）后，本组件退居为「外壳内的被动渲染器」：
 *  - 视口 / 当前工具不再由本组件持有 —— 改由 CanvasShell 经 props 下发。
 *  - Board 自有手势改变视口 → `viewport` prop 变化 → 本组件推进 Excalidraw。
 *  - Excalidraw 自身仍可能改视口（抓手工具 / 导入聚焦）→ `onChange` 取得后
 *    经 `onViewportChange` 上报外壳。两端经同一份外壳 state 调和，靠近似相等
 *    判定（viewportsEqual）掐断回环。
 *
 * 数据流（场景）：
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
  bindDrawnConnectors,
  type ExViewportState,
} from '../bridge';
import { OverlayLayer } from '../overlay/OverlayLayer';
import { PresenceLayer } from '../presence/PresenceLayer';
import { viewportsEqual, type CanvasViewport } from '../canvas/viewport';
import './BoardCanvas.css';

/**
 * 精简 Excalidraw 自带 UI —— Board 只保留绘图必需项，去掉与 Board 无关的部分。
 * 常量放模块作用域，保证引用稳定（避免 Excalidraw 反复重渲染）。
 */
const EXCALIDRAW_UI_OPTIONS = {
  // 关掉图片工具 —— Board 的文件靠覆盖层 / server，不用 Excalidraw 图片。
  tools: { image: false },
  // 汉堡菜单里的画布动作全部关掉 —— 这些功能 Board 顶栏已自带。
  canvasActions: {
    loadScene: false,
    saveToActiveFile: false,
    export: false as const,
    saveAsImage: false,
    toggleTheme: false,
    clearCanvas: false,
    changeViewBackgroundColor: false,
  },
};

/**
 * Excalidraw 初始数据 —— 背景设为透明，使 Board 的暖色底与网格能透出。
 * 模块常量，引用稳定。
 */
const EXCALIDRAW_INITIAL_DATA = {
  appState: { viewBackgroundColor: 'transparent' },
};

export interface BoardCanvasProps {
  /** 当前视口 —— 由 CanvasShell 持有并下发。 */
  viewport: CanvasViewport;
  /** Excalidraw 自身改了视口（抓手 / 聚焦）时上报外壳。 */
  onViewportChange: (viewport: CanvasViewport) => void;
  /** 当前工具 id（Excalidraw 工具类型字符串）。 */
  activeTool: string;
  /** Excalidraw 自身切换了工具（如画完自动回到选择）时上报外壳。 */
  onActiveToolChange: (tool: string) => void;
}

export function BoardCanvas({
  viewport,
  onViewportChange,
  activeTool,
  onActiveToolChange,
}: BoardCanvasProps): JSX.Element {
  const { scene, actorId, replaceScene, importTick, importFit, syncTick } =
    useBoard();
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);

  // 始终持有最新场景，供 onChange 闭包做 id 对齐（保留 z/parentId 等）。
  const sceneRef = useRef(scene);
  sceneRef.current = scene;

  // 始终持有最新视口 / 工具 —— onChange 闭包据此判定 Excalidraw 的变化是否
  // 只是 Board 下发值的回声（相等则不再上报，掐断回环）。
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const activeToolRef = useRef(activeTool);
  activeToolRef.current = activeTool;

  // true 时吞掉下一次 onChange 对场景的写回（它由程序化 updateScene 引发）。
  // 注意：视口仍照常处理 —— 程序化更新也会改 scrollX/scrollY/zoom。
  const suppressNextChange = useRef(false);

  // 任意指针是否按下中。用来判断「绘制手势是否结束」—— 用户拖画箭头 / 文本
  // 期间不回推 Excalidraw，否则会打断手势、连线还没画完就被收走。
  // appState.cursorButton 在部分 Excalidraw 版本里不可靠，故自行用捕获阶段
  // 的 window pointer 事件跟踪（早于 Excalidraw 自身处理 → onChange 时已最新）。
  const pointerDownRef = useRef(false);

  /**
   * 稳定的 Excalidraw API 回调。必须 useCallback：
   * 内联函数每次渲染都是新引用，会让 Excalidraw 反复重新初始化，
   * 与 onChange → 场景写回 → 重渲染 形成无限渲染循环。
   */
  const handleApi = useCallback((api: ExcalidrawImperativeAPI) => {
    apiRef.current = api;
  }, []);

  /** Excalidraw 元素 / 视口变化 → 写回 core 场景 + 上报视口 / 工具变化。 */
  const handleChange = useCallback(
    (elements: readonly ExcalidrawElement[], appState: AppState) => {
      // 视口：Excalidraw 自身改了视口（抓手平移 / 聚焦）才上报外壳；若与外壳
      // 当前下发值近似相等，本次 onChange 只是 Board 推进 Excalidraw 的回声，
      // 不上报 —— 否则 外壳→Excalidraw→外壳 回环。
      const exVp: CanvasViewport = {
        scrollX: appState.scrollX,
        scrollY: appState.scrollY,
        zoom: appState.zoom.value,
      };
      if (!viewportsEqual(exVp, viewportRef.current)) {
        onViewportChange(exVp);
      }

      // 当前工具：Excalidraw 自身切了工具（画完自动回到选择等）才上报。
      const tool =
        (appState as { activeTool?: { type?: string } }).activeTool?.type ??
        'selection';
      if (tool !== activeToolRef.current) {
        onActiveToolChange(tool);
      }

      if (suppressNextChange.current) {
        suppressNextChange.current = false;
        return;
      }
      const exViewport: ExViewportState = {
        scrollX: appState.scrollX,
        scrollY: appState.scrollY,
        zoom: { value: appState.zoom.value },
      };
      const next = excalidrawToScene(
        elements,
        exViewport,
        actorId,
        sceneRef.current,
      );

      // text 元素归 DOM 覆盖层渲染为 Markdown 卡片；连线（arrow/line）归覆盖层
      // SVG 渲染（见 ConnectorLayer）—— 两者都不应留在 Excalidraw 内，否则与
      // 覆盖层重影。用户用文本 / 箭头 / 线条工具画完后，把不含这些类型的场景
      // 回推 Excalidraw，使其丢弃原生元素、交由覆盖层接管。
      // 回推时机：仍在编辑文本（editingElement 非空）或指针仍按下（绘制手势
      // 未结束）时不回推 —— 以免打断输入框 / 中断绘制手势。
      const editing = (appState as { editingElement?: unknown }).editingElement;
      const drawing = pointerDownRef.current;
      // 自由文本（用户用文本工具新建、无 containerId）与连线（arrow/line）
      // 都要回收给覆盖层；图形的绑定标签文本（containerId 非空）不算。
      const hasOverlayDrawn = elements.some(
        (e) =>
          e.type === 'arrow' ||
          e.type === 'line' ||
          (e.type === 'text' && !(e as { containerId?: unknown }).containerId),
      );
      const finalize = !editing && !drawing && hasOverlayDrawn;

      // 画完一条连线（指针抬起）时：把它的自由端点吸附到落在其上的元素，
      // 使「画箭头」也能连接图形 / 文件 / 区域等覆盖层元素。
      let committed = next;
      if (finalize) {
        const arrowIds = new Set(
          elements
            .filter((e) => e.type === 'arrow' || e.type === 'line')
            .map((e) => e.id),
        );
        committed = bindDrawnConnectors(next, arrowIds);
      }
      replaceScene(committed, 'canvas');

      if (finalize && apiRef.current) {
        suppressNextChange.current = true;
        apiRef.current.updateScene({
          elements: sceneToExcalidraw(committed).elements,
        });
      }
    },
    [actorId, replaceScene, onViewportChange, onActiveToolChange],
  );

  // 捕获阶段跟踪全局指针按下状态 —— 见 pointerDownRef 注释。
  useEffect(() => {
    const down = (): void => {
      pointerDownRef.current = true;
    };
    const up = (): void => {
      pointerDownRef.current = false;
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
    };
  }, []);

  // 外壳视口变化 → 推进 Excalidraw。仅当与 Excalidraw 现值不同才推 ——
  // 若相同（本次 viewport 变化本就是 Excalidraw 自身改的、经 onChange 上报
  // 回来的），跳过，不形成回环。
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    const st = api.getAppState();
    const cur: CanvasViewport = {
      scrollX: st.scrollX,
      scrollY: st.scrollY,
      zoom: st.zoom.value,
    };
    if (viewportsEqual(cur, viewport)) return;
    api.updateScene({
      appState: {
        scrollX: viewport.scrollX,
        scrollY: viewport.scrollY,
        zoom: { value: viewport.zoom as AppState['zoom']['value'] },
      },
    });
  }, [viewport]);

  // 外壳选了工具 → 同步给 Excalidraw。仅当与现值不同才设，避免回环。
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    const cur = api.getAppState().activeTool?.type;
    if (cur === activeTool) return;
    api.setActiveTool({
      type: activeTool,
    } as Parameters<ExcalidrawImperativeAPI['setActiveTool']>[0]);
  }, [activeTool]);

  // 导入 / 刷新发生时（importTick 变化）：把内存场景推进 Excalidraw。
  useEffect(() => {
    if (importTick === 0) return; // 初始空场景无需推送
    const api = apiRef.current;
    if (!api) return;
    const { elements, appState } = sceneToExcalidraw(sceneRef.current);
    suppressNextChange.current = true;
    if (importFit) {
      // 用户导入 / 首次连接：把元素与视口都推进 Excalidraw，并聚焦到全部内容。
      api.updateScene({
        elements,
        appState: {
          scrollX: appState.scrollX,
          scrollY: appState.scrollY,
          zoom: { value: appState.zoom.value as AppState['zoom']['value'] },
        },
      });
      if (elements.length > 0) {
        api.scrollToContent(elements, { fitToContent: true });
      }
    } else {
      // SSE 后台刷新（拖拽移动文件触发的 reconcile 等）：只更新元素，
      // **绝不**推入视口 —— 否则会把画布跳回场景里存的旧视口，
      // 用户当前正看的位置被打断（拖文件进区域后画面乱跳的根因）。
      api.updateScene({ elements });
    }
    // importFit 与 importTick 在同一次 setState 中更新，读取的即为本次值。
  }, [importTick]);

  // 覆盖层动了 Excalidraw 原生元素（如拖区域带动其内图形）→ syncTick 自增。
  // 把场景重推进 Excalidraw 让图形跟随；只更新元素、不动视口。
  useEffect(() => {
    if (syncTick === 0) return;
    const api = apiRef.current;
    if (!api) return;
    const { elements } = sceneToExcalidraw(sceneRef.current);
    suppressNextChange.current = true;
    api.updateScene({ elements });
  }, [syncTick]);

  return (
    <div className="board-canvas">
      <Excalidraw
        excalidrawAPI={handleApi}
        onChange={handleChange}
        UIOptions={EXCALIDRAW_UI_OPTIONS}
        initialData={EXCALIDRAW_INITIAL_DATA}
      />
      {/* DOM 覆盖层 —— 叠在 Excalidraw 之上，渲染 file/folder/region 内容元素 */}
      <OverlayLayer scene={scene} viewport={viewport} activeTool={activeTool} />
      {/* 在场光标层（M4）—— 叠在最上层，纯展示对端光标 */}
      <PresenceLayer viewport={viewport} />
    </div>
  );
}
