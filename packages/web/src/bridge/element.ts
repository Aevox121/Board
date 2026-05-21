/**
 * 元素桥接 — Excalidraw 元素 ⇄ @board/core `Element` 的双向转换器。
 *
 * 类型对应表（M1 范围）：
 * | Excalidraw                        | core            | 备注 |
 * |-----------------------------------|-----------------|------|
 * | rectangle / ellipse / diamond     | shape           | shape 字段直存几何类型 |
 * | arrow / line                      | connector       | line → endArrow 'none'；arrow → endArrow 'arrow' |
 * | freedraw                          | draw            | points/pressures 转为相对左上角 |
 * | text                              | text            | 纯文本存入 markdown；仅入向（core text 归覆盖层渲染，不回 Excalidraw） |
 * | image / frame / embeddable / 未知 | （原样存入 meta）| 见 unknownToCore，保证往返不丢 |
 *
 * 设计原则：
 *  - core → Excalidraw：产出「骨架」（Partial），交给 restoreElements 补 seed/version 等。
 *  - Excalidraw → core：尽力而为映射几何/样式；带绑定/容器关系的字段存进 `meta.ex`，
 *    回程时优先复用，最大限度保证往返一致（round-trip）。
 *  - 未知 Excalidraw 类型：整对象塞进 core 元素的 `meta.exRaw`，core 元素本身记为占位。
 */
import {
  type Element,
  type ShapeElement,
  type ConnectorElement,
  type DrawElement,
  type TextElement,
  type ShapeKind,
  type ArrowHead,
  type Style,
  type ParticipantId,
  type ElementId,
  newElementId,
} from '@board/core';
import type { ExElement, ExElementSkeleton, ExPoint } from './types';
import type { ExcalidrawElementSkeleton } from '@excalidraw/excalidraw/types/data/transform';
import { styleToExcalidraw, styleFromExcalidraw } from './style';

const nowISO = (): string => new Date().toISOString();

/** Excalidraw 字体常量（constants.ts FONT_FAMILY）。 */
const EX_FONT = { Virgil: 1, Helvetica: 2, Cascadia: 3 } as const;

/** Excalidraw fontFamily 数值 → core fontFamily。 */
function toCoreFontFamily(f: number): Style['fontFamily'] {
  if (f === EX_FONT.Cascadia) return 'code';
  if (f === EX_FONT.Helvetica) return 'normal';
  return 'hand';
}

// ───────────────────────── core → Excalidraw ─────────────────────────

/** core envelope 通用字段 → Excalidraw 骨架通用字段。 */
function baseSkeleton(el: Element): ExElementSkeleton {
  const stylePart = styleToExcalidraw(el.style);
  // id 复用 core 元素 id：Excalidraw id 无格式约束，复用可保证双向对应稳定。
  return {
    type: 'rectangle', // 占位，调用方覆盖
    id: el.id,
    x: el.x,
    y: el.y,
    width: el.width,
    height: el.height,
    angle: el.angle,
    locked: el.locked,
    ...stylePart,
  };
}

/**
 * core `Element` → Excalidraw 元素骨架。
 * 无法用 Excalidraw 原生类型表达的（file/folder/region/suggestion/embed/image）
 * 返回 null —— M1 画布只承载绘图类元素。
 */
export function coreToExcalidraw(el: Element): ExElementSkeleton | null {
  const base = baseSkeleton(el);

  switch (el.type) {
    case 'shape': {
      // core 的 shape 几何类型与 Excalidraw type 同名（rectangle/ellipse/diamond）
      const sk: ExElementSkeleton = { ...base, type: el.shape };
      // 图形内文字（label）：Excalidraw 用独立的绑定 text 元素承载。
      // M1 简化：label 作为 customData 暂存，渲染层不展开为独立元素。
      if (el.label) {
        sk.customData = { boardLabel: el.label };
      }
      return sk;
    }
    case 'draw': {
      const sk: ExElementSkeleton = {
        ...base,
        type: 'freedraw',
        points: el.points.map((p): ExPoint => [p[0], p[1]]),
      };
      if (el.pressures) {
        sk.pressures = [...el.pressures];
      }
      return sk;
    }
    // connector/text/file/folder/region/image/suggestion/embed —— 不进
    // Excalidraw 场景。connector（连线）与 text（Markdown 卡片）等内容元素
    // 一并由 DOM 覆盖层渲染。
    default:
      return null;
  }
}

// ───────────────────────── Excalidraw → core ─────────────────────────

function fromExArrowhead(a: unknown): ArrowHead {
  if (a === 'triangle') return 'triangle';
  if (a === 'dot') return 'dot';
  if (a === 'bar') return 'arrow'; // core 无 bar，归一为 arrow
  if (a === 'arrow') return 'arrow';
  return 'none';
}

/** 取 Excalidraw 线性元素的端点绑定目标 id（无绑定返回 null）。 */
function bindingElementId(
  ex: ExElement,
  key: 'startBinding' | 'endBinding',
): string | null {
  const b = (ex as Record<string, unknown>)[key];
  if (b && typeof b === 'object') {
    const id = (b as { elementId?: unknown }).elementId;
    if (typeof id === 'string' && id) return id;
  }
  return null;
}

/** core envelope 通用字段构造（Excalidraw → core 公用）。 */
function coreEnvelope(
  ex: ExElement,
  actor: ParticipantId,
  prev: Element | undefined,
  style: Style,
): Omit<Element, 'type'> & { type: Element['type'] } {
  const ts = nowISO();
  // id 复用：coreToExcalidraw 把 core id 写进了 ex.id，所以这里直接拿回。
  const id: ElementId = (prev?.id ?? ex.id) || newElementId();
  return {
    id,
    type: prev?.type ?? 'shape',
    x: ex.x,
    y: ex.y,
    width: ex.width,
    height: ex.height,
    angle: ex.angle,
    z: prev?.z ?? '00000000',
    parentId: prev?.parentId ?? null,
    locked: ex.locked,
    state: prev?.state ?? 'committed',
    autoPlaced: prev?.autoPlaced ?? false,
    style,
    createdBy: prev?.createdBy ?? actor,
    updatedBy: actor,
    createdAt: prev?.createdAt ?? ts,
    updatedAt: ts,
    meta: prev?.meta,
  } as Omit<Element, 'type'> & { type: Element['type'] };
}

const SHAPE_KINDS: ReadonlySet<string> = new Set([
  'rectangle',
  'ellipse',
  'diamond',
]);

/**
 * 求 core `shape` 的 label（图形内文字）。
 *
 * Excalidraw 把图形内文字存为一个**独立的 text 元素**，带 `containerId` 指回
 * 图形——它不是白板的独立文本卡。`excalidrawToScene` 会把这类绑定文本从
 * 活元素里滤掉、单独传进来（`boundText`）。
 *
 * 真相源是 `boundText`：
 *  - 有 `boundText` 且文字非空 → label = 该文字（含字号）。
 *  - 无 `boundText` → 图形当前没有标签（从未输入 / 已清空）→ null。
 *
 * **不退回 `prev.label`**：图形有 label 时 `sceneToExcalidraw` 必定经
 * `convertToExcalidrawElements` 物化出绑定文本，故「有 label ⇔ 有 boundText」。
 * 若无 boundText 仍取 prev.label，既会让用户清空的标签复活，又——这是关键——
 * 旧实现读的是从不被赋值的 `customData.boardLabel`、再退回 `prev.label`，导致
 * 用户**新输入 / 修改**的图形内文字永远写不进 core，下次重渲染即丢失，
 * 表现为「方框 / 圆框 / 菱形框内文本异常消失」。
 */
function shapeLabelOf(
  ex: ExElement,
  boundText: ExElement | null | undefined,
): ShapeElement['label'] {
  if (boundText) {
    const raw = (boundText as { text?: string }).text ?? '';
    if (raw.trim() === '') return null;
    const fontSize = (boundText as { fontSize?: number }).fontSize;
    return typeof fontSize === 'number' ? { text: raw, fontSize } : { text: raw };
  }
  // exRaw 还原路径（未知类型占位壳）暂存的 label——正常图形不会走到这里。
  const labelRaw = ex.customData?.['boardLabel'];
  if (labelRaw && typeof labelRaw === 'object') {
    return labelRaw as ShapeElement['label'];
  }
  return null;
}

/**
 * Excalidraw 元素 → core `Element`。
 *
 * @param ex        Excalidraw 元素
 * @param actor     当前参与者 id（写入 updatedBy）
 * @param prev      上一轮同 id 的 core 元素（若有）——用于保留 z / parentId /
 *                  state / createdAt 等 Excalidraw 不持有的字段
 * @param boundText 绑定在该元素上的标签文本（图形内文字）；由
 *                  `excalidrawToScene` 按 containerId 配好后传入，无则 null
 */
export function excalidrawToCore(
  ex: ExElement,
  actor: ParticipantId,
  prev?: Element,
  boundText?: ExElement | null,
): Element {
  const style = styleFromExcalidraw(ex);
  const env = coreEnvelope(ex, actor, prev, style);

  switch (ex.type) {
    case 'rectangle':
    case 'ellipse':
    case 'diamond': {
      const shape = ex.type as ShapeKind;
      const result: ShapeElement = {
        ...env,
        type: 'shape',
        shape,
        label: shapeLabelOf(ex, boundText),
      };
      // 字体来自样式默认；shape 自身无字号字段。
      return result;
    }
    case 'arrow':
    case 'line': {
      const prevConn = prev?.type === 'connector' ? prev : undefined;
      const startArrow = fromExArrowhead(ex.startArrowhead);
      const endArrow =
        ex.type === 'line' ? 'none' : fromExArrowhead(ex.endArrowhead);
      // Excalidraw 把箭头端点吸附到图形时记在 start/endBinding 上 —— 取其
      // elementId 作为 core 端点绑定，使图形↔图形连线随图形移动跟随。
      const startBind = bindingElementId(ex, 'startBinding');
      const endBind = bindingElementId(ex, 'endBinding');
      const result: ConnectorElement = {
        ...env,
        type: 'connector',
        start: startBind
          ? { elementId: startBind, anchor: 'auto' }
          : (prevConn?.start ?? { elementId: null, anchor: 'auto' }),
        end: endBind
          ? { elementId: endBind, anchor: 'auto' }
          : (prevConn?.end ?? { elementId: null, anchor: 'auto' }),
        startArrow: ex.type === 'line' ? 'none' : startArrow,
        endArrow,
        routing: prevConn?.routing ?? 'straight',
        label: prevConn?.label ?? null,
      };
      // 保存 Excalidraw 的折线/曲线点，回程时复用以保持形状。
      result.meta = {
        ...result.meta,
        ex: { points: cloneJSON(ex.points) },
      };
      return result;
    }
    case 'freedraw': {
      const points = (ex.points ?? []).map(
        (p): [number, number] => [p[0] ?? 0, p[1] ?? 0],
      );
      const result: DrawElement = {
        ...env,
        type: 'draw',
        points,
      };
      const pressures = (ex as { pressures?: readonly number[] }).pressures;
      if (pressures && pressures.length > 0) {
        result.pressures = [...pressures];
      }
      return result;
    }
    case 'text': {
      const prevText = prev?.type === 'text' ? prev : undefined;
      const txt = (ex as { text?: string }).text ?? '';
      const fontFamily = (ex as { fontFamily?: number }).fontFamily;
      const fontSize = (ex as { fontSize?: number }).fontSize;
      const styledText: Style = {
        ...style,
        fontFamily:
          fontFamily != null ? toCoreFontFamily(fontFamily) : style.fontFamily,
        fontSize: fontSize ?? style.fontSize,
      };
      const result: TextElement = {
        ...env,
        style: styledText,
        type: 'text',
        // 纯文本存入 markdown 字段（PRD §6.3：短文本走 text 元素）
        markdown: txt,
        autoWidth: prevText?.autoWidth ?? true,
        editMode: prevText?.editMode ?? 'preview',
      };
      return result;
    }
    // image / frame / embeddable 及任何未来新增的 Excalidraw 类型：
    // 无 core 原生映射 —— 整个原始对象塞进 meta.exRaw 以保证往返不丢。
    default:
      return unknownToCore(ex, env);
  }
}

/**
 * 未知/未映射的 Excalidraw 元素 → core 占位元素。
 * 用一个 `shape`(rectangle) 作壳承载几何，原始对象存进 `meta.exRaw`，
 * 这样导出 board.json 再导入时数据不丢；coreToExcalidraw 也可据此还原。
 */
function unknownToCore(
  ex: ExElement,
  env: Omit<Element, 'type'> & { type: Element['type'] },
): Element {
  const result: ShapeElement = {
    ...env,
    type: 'shape',
    shape: 'rectangle',
    label: null,
    meta: {
      ...env.meta,
      exRaw: cloneJSON(ex),
      exType: ex.type,
    },
  };
  return result;
}

/** 结构化深拷贝（去掉只读、可安全 JSON 序列化）。 */
function cloneJSON<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * core 元素若是「未知 Excalidraw 类型的占位壳」，取回其原始对象。
 * 用于 coreToExcalidraw 之前的还原判断。
 */
export function rawExcalidrawOf(el: Element): Partial<ExElement> | null {
  const raw = el.meta?.['exRaw'];
  if (raw && typeof raw === 'object') {
    return cloneJSON(raw) as Partial<ExElement>;
  }
  return null;
}

// ──────── core → Excalidraw 骨架（convertToExcalidrawElements 专用）────────
//
// shape 走 convertToExcalidrawElements：它能把骨架上的 `label` 自动展开为
// 「绑定文本」（图形内文字）—— 这是手搓 restoreElements 骨架做不到的。
// connector（连线）不走此路径 —— 它归 DOM 覆盖层 SVG 渲染（见 ConnectorLayer）。

/**
 * core `shape` → convertToExcalidrawElements 容器骨架。
 * `label` 交给 convertToExcalidrawElements 生成图形内的绑定文本。
 */
export function shapeToSkeleton(el: ShapeElement): ExcalidrawElementSkeleton {
  const skeleton = {
    type: el.shape,
    id: el.id,
    x: el.x,
    y: el.y,
    width: el.width,
    height: el.height,
    angle: el.angle,
    locked: el.locked,
    ...styleToExcalidraw(el.style),
    ...(el.label ? { label: { text: el.label.text } } : {}),
  };
  return skeleton as unknown as ExcalidrawElementSkeleton;
}
