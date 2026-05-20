/**
 * DOM 覆盖层 —— 叠在 Excalidraw 画布之上，与画布**共享坐标系**渲染内容元素。
 *
 * 坐标系对齐原理（PRD §11「内容元素层」）：
 *  Excalidraw 把画布坐标 (x,y) 映射到屏幕的公式是
 *      screen = (x + scrollX) * zoom
 *  覆盖层用一个变换容器复刻这条公式：
 *      transform: translate(scrollX*zoom, scrollY*zoom) scale(zoom)
 *      transform-origin: 0 0
 *  容器内每个元素按其画布坐标 (x,y,width,height) 绝对定位，
 *  叠加容器变换后即与 Excalidraw 的视口完全一致——平移/缩放实时跟随。
 *
 * 事件穿透：
 *  - 外层 `pointer-events:none` —— 空白处事件穿透到下面的 Excalidraw。
 *  - 卡片本身 `pointer-events:auto`（见 overlay.css 的 `.ov-card`）—— 可交互。
 *
 * 渲染范围（M2）：只渲染 `file` / `folder` / `region` 三类内容元素；
 * draw/shape/connector/text 仍归 Excalidraw，本层不碰。元素按 `z` 升序
 * 扁平绝对定位 —— 区域 z 低 → 在下，文件 z 高 → 叠在区域之上。
 */
import { useMemo } from 'react';
import type { BoardScene, Element } from '@board/core';
import { FileCard } from './FileCard';
import { FolderCard } from './FolderCard';
import { RegionCard } from './RegionCard';
import './overlay.css';

/** 覆盖层关心的视口状态 —— 取自 Excalidraw appState。 */
export interface OverlayViewport {
  /** 画布平移 X（appState.scrollX）。 */
  scrollX: number;
  /** 画布平移 Y（appState.scrollY）。 */
  scrollY: number;
  /** 缩放（appState.zoom.value）。 */
  zoom: number;
}

export interface OverlayLayerProps {
  /** 内存中的白板场景（board.json 真相源）。 */
  scene: BoardScene;
  /** 当前视口 —— 由 BoardCanvas 从 Excalidraw onChange 取得并下传。 */
  viewport: OverlayViewport;
}

/** 本覆盖层负责渲染的内容元素类型。 */
type ContentElement = Extract<Element, { type: 'file' | 'folder' | 'region' }>;

/** 判断一个元素是否属于本层渲染范围。 */
function isContentElement(el: Element): el is ContentElement {
  return el.type === 'file' || el.type === 'folder' || el.type === 'region';
}

/** 按元素类型分发到对应的卡片组件。 */
function renderContent(el: ContentElement): JSX.Element {
  switch (el.type) {
    case 'region':
      return <RegionCard element={el} />;
    case 'folder':
      return <FolderCard element={el} />;
    case 'file':
      return <FileCard element={el} />;
  }
}

export function OverlayLayer({
  scene,
  viewport,
}: OverlayLayerProps): JSX.Element {
  const { scrollX, scrollY, zoom } = viewport;

  // 筛出内容元素并按 z 升序排序 —— 字典序即层级序（与 factory.nextZ 同构）。
  // 区域 z 通常低于其内文件 → 文件自然叠在区域之上（靠 z，不做 DOM 嵌套）。
  const contentElements = useMemo<ContentElement[]>(() => {
    return scene.elements
      .filter(isContentElement)
      .sort((a, b) => (a.z < b.z ? -1 : a.z > b.z ? 1 : 0));
  }, [scene.elements]);

  // 变换容器样式 —— 复刻 Excalidraw 的 screen = (canvas + scroll) * zoom。
  const transformStyle: React.CSSProperties = {
    transform: `translate(${scrollX * zoom}px, ${scrollY * zoom}px) scale(${zoom})`,
    transformOrigin: '0 0',
  };

  return (
    <div className="ov-root" aria-hidden={contentElements.length === 0}>
      <div className="ov-transform" style={transformStyle}>
        {contentElements.map((el) => (
          <div
            key={el.id}
            className="ov-slot"
            style={{
              // 元素在变换容器内按画布坐标绝对定位；容器变换负责缩放/平移。
              left: `${el.x}px`,
              top: `${el.y}px`,
              width: `${el.width}px`,
              height: `${el.height}px`,
            }}
          >
            {renderContent(el)}
          </div>
        ))}
      </div>
    </div>
  );
}
