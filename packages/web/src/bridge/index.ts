/**
 * Excalidraw ⇄ @board/core 桥接层入口。
 *
 * 职责：在 Excalidraw 的元素体系与 Board 自有数据模型之间做双向翻译。
 * 详见各文件头注释：
 *  - element.ts —— 单元素类型映射
 *  - style.ts   —— 统一样式字段映射
 *  - scene.ts   —— 整场景 + 视口映射
 */
export type { ExElement, ExElementSkeleton } from './types';
export {
  coreToExcalidraw,
  excalidrawToCore,
  rawExcalidrawOf,
} from './element';
export { styleToExcalidraw, styleFromExcalidraw } from './style';
export type { ExStyleFields } from './style';
export {
  sceneToExcalidraw,
  excalidrawToScene,
  bindDrawnConnectors,
} from './scene';
export type { ExcalidrawSceneData, ExViewportState } from './scene';
