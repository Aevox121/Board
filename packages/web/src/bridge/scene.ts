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
import { restoreElements, convertToExcalidrawElements } from '@excalidraw/excalidraw';
import type { ExcalidrawElementSkeleton } from '@excalidraw/excalidraw/types/data/transform';
import type { BoardScene, Element, ParticipantId } from '@board/core';
import { createBoardScene } from '@board/core';
import type { ExElement, ExElementSkeleton } from './types';
import {
  coreToExcalidraw,
  excalidrawToCore,
  rawExcalidrawOf,
  shapeToSkeleton,
} from './element';

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
 * 非绘图类元素（file/folder/region/text/connector 等）此阶段跳过 —— 它们归
 * DOM 覆盖层渲染。其中 `connector`（连线）由覆盖层以 SVG 绘制（见
 * `overlay/ConnectorLayer`），从而能连接任意元素（图形 / 文件卡 / 文本卡 /
 * 区域）并随其实时跟随。
 *
 * 两条转换路径：
 *  - shape → `convertToExcalidrawElements`：自动展开图形内文字（label → 绑定文本）。
 *  - draw / 未知占位壳 → `restoreElements`：补全 seed/version 等运行时字段。
 */
export function sceneToExcalidraw(scene: BoardScene): ExcalidrawSceneData {
  const ordered = [...scene.elements].sort((a, b) =>
    a.z < b.z ? -1 : a.z > b.z ? 1 : 0,
  );

  // restoreElements 路径：手绘 + 未知类型占位壳。
  const legacy: Array<ExElementSkeleton | Partial<ExElement>> = [];
  // convertToExcalidrawElements 路径：图形（含 label）。
  const shapeSkels: ExcalidrawElementSkeleton[] = [];

  for (const el of ordered) {
    // 连线归 DOM 覆盖层（SVG）渲染 —— 不进 Excalidraw 画布。
    if (el.type === 'connector') continue;
    // 未知类型占位壳：优先用原始 Excalidraw 对象还原，保证往返一致。
    const raw = rawExcalidrawOf(el);
    if (raw) {
      legacy.push(raw);
      continue;
    }
    if (el.type === 'shape') {
      shapeSkels.push(shapeToSkeleton(el));
      continue;
    }
    // draw → 骨架；file/folder/region/text/suggestion → null（归覆盖层）。
    const sk = coreToExcalidraw(el);
    if (sk) legacy.push(sk);
  }

  // restoreElements 补全 seed/version/versionNonce/updated 等，并修复绑定。
  const legacyEls = restoreElements(legacy as ExElement[], null, {
    repairBindings: true,
  });
  const modernEls =
    shapeSkels.length > 0
      ? convertToExcalidrawElements(shapeSkels, { regenerateIds: false })
      : [];

  return {
    elements: [...legacyEls, ...modernEls] as ExElement[],
    appState: {
      scrollX: scene.viewport.x,
      scrollY: scene.viewport.y,
      zoom: { value: scene.viewport.zoom },
    },
  };
}

/**
 * 归 Excalidraw 画布管理的元素类型；其余（file/folder/region/text/connector…）
 * 归 DOM 覆盖层。
 *
 * `text` 是白板原生的「文本 / Markdown 卡片」（数据模型 §6.4），需要 source/preview
 * 切换与 Markdown 渲染 —— Excalidraw 原生 text 表达不了，故归覆盖层渲染。
 * `connector`（连线）归覆盖层 SVG 渲染，以便连接任意元素并随其跟随，
 * 故同样作为「保留元素」由覆盖层接管、不在 Excalidraw 的 onChange 里。
 */
const DRAWING_TYPES: ReadonlySet<Element['type']> = new Set(['draw', 'shape']);

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

  // 图形内文字：Excalidraw 把它存为带 `containerId` 的独立 text 元素。先建
  // `containerId → 绑定文本` 索引——回程时这段文字要并入容器（shape）的
  // `label`，而绑定文本本身**不**作为独立 core 元素还原（否则覆盖层会多渲染
  // 一张文本卡）。不索引这层、只把绑定文本一滤了之，正是「图形内文本异常
  // 消失」bug 的源头——用户输入的文字回程时无处落脚。
  const boundTextByContainer = new Map<string, ExElement>();
  for (const e of exElements) {
    if (e.isDeleted || !isBoundText(e)) continue;
    const cid = (e as { containerId?: unknown }).containerId;
    if (typeof cid === 'string' && cid) boundTextByContainer.set(cid, e);
  }

  // 活元素：滤掉已删除元素与绑定标签文本（后者已并入容器 label，见上）。
  const live = exElements.filter((e) => !e.isDeleted && !isBoundText(e));

  // Excalidraw 侧的绘图元素 → core。
  const drawn: Element[] = live.map((ex, idx) => {
    const prev = prevById.get(ex.id);
    const core = excalidrawToCore(
      ex,
      actor,
      prev,
      boundTextByContainer.get(ex.id) ?? null,
    );
    // z 用数组下标派生：定宽 base36 递增串，字典序即层级序（与 factory.nextZ 同构）。
    return { ...core, z: idx.toString(36).padStart(8, '0') };
  });

  // 关键：保留上一份场景里的「内容元素」(file/folder/region/connector 等)。
  // 它们由 DOM 覆盖层渲染、不在 Excalidraw 的 onChange 里 —— 若不显式
  // 保留，每次画布同步都会把它们丢掉，覆盖层随即变空。
  //
  // 去重：preserved 必须排除 drawn 已含的 id。否则一个**既在 prevScene 里**
  // （非绘图类，如 connector / 自由 text）、**又仍是 Excalidraw 活元素**的
  // 元素（用户正用箭头 / 文本工具新画的那一刻），会同时进 preserved 与
  // drawn，每次 onChange 多积一份 —— 拖画一条线就堆出几百条残影并落盘。
  const drawnIds = new Set(drawn.map((el) => el.id));
  const preserved: Element[] = prevScene
    ? prevScene.elements.filter(
        (el) => !DRAWING_TYPES.has(el.type) && !drawnIds.has(el.id),
      )
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

/** 取 connector 元素 meta.ex.points（折线相对顶点；无则 null）。 */
function exPointsOf(el: Element): Array<[number, number]> | null {
  const ex = el.meta?.['ex'];
  const raw =
    ex && typeof ex === 'object' ? (ex as { points?: unknown }).points : null;
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const out: Array<[number, number]> = [];
  for (const p of raw) {
    if (
      Array.isArray(p) &&
      typeof p[0] === 'number' &&
      typeof p[1] === 'number'
    ) {
      out.push([p[0], p[1]]);
    }
  }
  return out.length >= 2 ? out : null;
}

/**
 * 把刚用箭头工具画完的连线的自由端点，吸附到落在其上的元素。
 *
 * Excalidraw 原生绑定只覆盖图形（excalidrawToCore 已读取 start/endBinding）；
 * 本函数补足覆盖层元素（文件 / 文本 / 文件夹 / 区域）—— 对未绑定端点做命中
 * 测试，落在某元素矩形内（含 TOL 容差）即绑定到该元素，连线遂能连接任意
 * 元素并随其移动 / 缩放跟随。
 *
 * @param scene    当前场景
 * @param arrowIds 当前仍是 Excalidraw arrow/line 活元素的 id 集合 —— 只对这些
 *                 「刚画的」连线做吸附，不动既有连线。
 */
export function bindDrawnConnectors(
  scene: BoardScene,
  arrowIds: ReadonlySet<string>,
): BoardScene {
  if (arrowIds.size === 0) return scene;

  // 可作为端点的元素（连线 / 建议除外）。
  const targets = scene.elements.filter(
    (e) => e.type !== 'connector' && e.type !== 'suggestion',
  );
  const TOL = 12;
  // 命中测试取「最小面积」元素 —— 点同时落在卡片与其所在区域内时取卡片
  // （区域内的多个元素方能各自被连），且不依赖易冲突的 z 值。
  const hitTest = (px: number, py: number): string | null => {
    let found: string | null = null;
    let bestArea = Infinity;
    for (const t of targets) {
      if (
        px >= t.x - TOL &&
        px <= t.x + t.width + TOL &&
        py >= t.y - TOL &&
        py <= t.y + t.height + TOL
      ) {
        const area = t.width * t.height;
        if (area < bestArea) {
          bestArea = area;
          found = t.id;
        }
      }
    }
    return found;
  };

  let changed = false;
  const elements = scene.elements.map((el): Element => {
    if (el.type !== 'connector' || !arrowIds.has(el.id)) return el;
    const pts = exPointsOf(el);
    if (!pts) return el;
    const p0 = pts[0]!;
    const pN = pts[pts.length - 1]!;
    // 已绑定端点保留；未绑定端点做命中测试。
    let sId = el.start.elementId;
    let eId = el.end.elementId;
    if (!sId) sId = hitTest(el.x + p0[0], el.y + p0[1]);
    if (!eId) eId = hitTest(el.x + pN[0], el.y + pN[1]);
    // 两端命中同一元素且原本都未绑定 → 多半是误吸附（在某区域内画的自由
    // 箭头），撤销，保留自由连线。
    if (sId && sId === eId && !el.start.elementId && !el.end.elementId) {
      sId = null;
      eId = null;
    }
    if (sId === el.start.elementId && eId === el.end.elementId) return el;
    changed = true;
    return {
      ...el,
      start: { ...el.start, elementId: sId },
      end: { ...el.end, elementId: eId },
    };
  });
  return changed ? { ...scene, elements } : scene;
}

/** 把缩放钳制到规格允许的 0.1–5.0。 */
function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.min(5, Math.max(0.1, z));
}

/**
 * 是否为绑定在容器（图形 / 连线）上的标签文本。
 * convertToExcalidrawElements 把骨架的 `label` 展开成带 `containerId` 的 text
 * 元素 —— 它属于容器的 label，不是独立的白板文本卡，回程时应跳过。
 */
function isBoundText(e: ExElement): boolean {
  return (
    e.type === 'text' &&
    typeof (e as { containerId?: unknown }).containerId === 'string'
  );
}
