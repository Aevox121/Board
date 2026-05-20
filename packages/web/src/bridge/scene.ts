/**
 * 场景桥接 — @board/core `BoardScene` ⇄ Excalidraw 场景（元素 + appState）。
 *
 * - `sceneToExcalidraw`：core 场景 → 可喂给 `updateScene` 的元素数组 + appState 片段。
 *   产出的骨架经 `restoreElements` 补全 seed/version 等运行时字段。
 * - `excalidrawToScene`：Excalidraw 当前元素 + appState → core 场景。
 *   逐元素调 `excalidrawToCore`，并按上一份场景做 id 对齐以保留 z/parentId 等。
 *
 * 视口映射：core `viewport.{x,y}` 是画布坐标原点；Excalidraw appState 用
 * `scrollX/scrollY`（= 视口左上对应的画布坐标的相反量级）。M1 直接对应：
 *   scrollX = viewport.x，scrollY = viewport.y。
 */
import { restoreElements } from '@excalidraw/excalidraw';
import type { BoardScene, Element, ParticipantId } from '@board/core';
import { createBoardScene } from '@board/core';
import type { ExElement } from './types';
import { coreToExcalidraw, excalidrawToCore, rawExcalidrawOf } from './element';

/** Excalidraw appState 中本桥接关心的视口字段。 */
export interface ExViewportState {
  scrollX: number;
  scrollY: number;
  zoom: { value: number };
}

/** sceneToExcalidraw 的产出。 */
export interface ExcalidrawSceneData {
  elements: ExElement[];
  appState: ExViewportState;
}

/**
 * core 场景 → Excalidraw 场景数据。
 *
 * core 元素按 `z` 升序排列后转换（Excalidraw 用数组顺序表达层级）。
 * 非绘图类元素（file/folder/region/text 等）此阶段跳过 —— 它们归 DOM 覆盖层。
 */
export function sceneToExcalidraw(scene: BoardScene): ExcalidrawSceneData {
  const ordered = [...scene.elements].sort((a, b) =>
    a.z < b.z ? -1 : a.z > b.z ? 1 : 0,
  );

  const skeletons = ordered
    .map((el) => {
      // 未知类型占位壳：优先用原始 Excalidraw 对象还原，保证往返一致。
      const raw = rawExcalidrawOf(el);
      if (raw) return raw;
      return coreToExcalidraw(el);
    })
    .filter((s): s is NonNullable<typeof s> => s != null);

  // restoreElements 补全 seed/version/versionNonce/updated 等，并修复绑定。
  const elements = restoreElements(skeletons as ExElement[], null, {
    repairBindings: true,
  });

  return {
    elements,
    appState: {
      scrollX: scene.viewport.x,
      scrollY: scene.viewport.y,
      zoom: { value: scene.viewport.zoom },
    },
  };
}

/**
 * 归 Excalidraw 画布管理的元素类型；其余（file/folder/region/text…）归 DOM 覆盖层。
 *
 * `text` 是白板原生的「文本 / Markdown 卡片」（数据模型 §6.4），需要 source/preview
 * 切换与 Markdown 渲染 —— Excalidraw 原生 text 表达不了，故归覆盖层渲染。
 */
const DRAWING_TYPES: ReadonlySet<Element['type']> = new Set([
  'draw',
  'shape',
  'connector',
]);

/**
 * Excalidraw 元素 + 视口 → core 场景。
 *
 * @param exElements 当前 Excalidraw 元素（应已过滤 isDeleted）
 * @param viewport   Excalidraw appState 的视口字段
 * @param actor      当前参与者 id
 * @param prevScene  上一份 core 场景——按 id 对齐以保留 z/parentId/state 等
 */
export function excalidrawToScene(
  exElements: readonly ExElement[],
  viewport: ExViewportState,
  actor: ParticipantId,
  prevScene?: BoardScene,
): BoardScene {
  const prevById = new Map<string, Element>();
  if (prevScene) {
    for (const el of prevScene.elements) prevById.set(el.id, el);
  }

  const live = exElements.filter((e) => !e.isDeleted);

  // Excalidraw 侧的绘图元素 → core。
  const drawn: Element[] = live.map((ex, idx) => {
    const prev = prevById.get(ex.id);
    const core = excalidrawToCore(ex, actor, prev);
    // z 用数组下标派生：定宽 base36 递增串，字典序即层级序（与 factory.nextZ 同构）。
    return { ...core, z: idx.toString(36).padStart(8, '0') };
  });

  // 关键：保留上一份场景里的「内容元素」(file/folder/region 等)。
  // 它们由 DOM 覆盖层渲染、不在 Excalidraw 的 onChange 里 —— 若不显式
  // 保留，每次画布同步都会把它们丢掉，覆盖层随即变空。
  const preserved: Element[] = prevScene
    ? prevScene.elements.filter((el) => !DRAWING_TYPES.has(el.type))
    : [];

  const base = createBoardScene();
  return {
    ...base,
    viewport: {
      x: viewport.scrollX,
      y: viewport.scrollY,
      zoom: clampZoom(viewport.zoom.value),
    },
    elements: [...preserved, ...drawn],
  };
}

/** 把缩放钳制到规格允许的 0.1–5.0。 */
function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.min(5, Math.max(0.1, z));
}
