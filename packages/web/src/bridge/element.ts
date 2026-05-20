/**
 * 元素桥接 — Excalidraw 元素 ⇄ @board/core `Element` 的双向转换器。
 *
 * 类型对应表（M1 范围）：
 * | Excalidraw                        | core            | 备注 |
 * |-----------------------------------|-----------------|------|
 * | rectangle / ellipse / diamond     | shape           | shape 字段直存几何类型 |
 * | arrow / line                      | connector       | line → endArrow 'none'；arrow → endArrow 'arrow' |
 * | freedraw                          | draw            | points/pressures 转为相对左上角 |
 * | text                              | text            | 纯文本存入 markdown 字段 |
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
import type {
  ExElement,
  ExElementSkeleton,
  ExPoint,
  ExArrowheadValue,
} from './types';
import { styleToExcalidraw, styleFromExcalidraw } from './style';

const nowISO = (): string => new Date().toISOString();

/** Excalidraw 字体常量（constants.ts FONT_FAMILY）。 */
const EX_FONT = { Virgil: 1, Helvetica: 2, Cascadia: 3 } as const;

/** core fontFamily → Excalidraw fontFamily 数值。 */
function toExFontFamily(f: Style['fontFamily']): number {
  if (f === 'code') return EX_FONT.Cascadia;
  if (f === 'normal') return EX_FONT.Helvetica;
  return EX_FONT.Virgil; // hand → 手写体 Virgil/Excalifont
}

/** Excalidraw fontFamily 数值 → core fontFamily。 */
function toCoreFontFamily(f: number): Style['fontFamily'] {
  if (f === EX_FONT.Cascadia) return 'code';
  if (f === EX_FONT.Helvetica) return 'normal';
  return 'hand';
}

// ───────────────────────── core → Excalidraw ─────────────────────────

/** connector 元素 meta.ex 里保存的 Excalidraw 形状信息。 */
interface ConnectorExMeta {
  points?: ExPoint[];
}

/** 从 connector 元素 meta 中取回上次保存的 Excalidraw 形状信息（若有）。 */
function connectorExMetaOf(el: Element): ConnectorExMeta | null {
  const raw = el.meta?.['ex'];
  return raw && typeof raw === 'object' ? (raw as ConnectorExMeta) : null;
}

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
    case 'connector': {
      const isLine = el.startArrow === 'none' && el.endArrow === 'none';
      const exMeta = connectorExMetaOf(el);
      const sk: ExElementSkeleton = {
        ...base,
        type: isLine ? 'line' : 'arrow',
        startArrowhead: toExArrowhead(el.startArrow),
        endArrowhead: toExArrowhead(el.endArrow),
      };
      // 优先复用上次保存的 points（保持折线/曲线形状）；否则按包围盒给两点直线。
      const exPoints = exMeta?.points;
      sk.points =
        Array.isArray(exPoints) && exPoints.length >= 2
          ? exPoints.map((p): ExPoint => [p[0], p[1]])
          : [
              [0, 0],
              [el.width, el.height],
            ];
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
    case 'text': {
      const sk: ExElementSkeleton = {
        ...base,
        type: 'text',
        // core text 是 markdown 卡片；M1 画布以纯文本回显其 markdown 源。
        text: el.markdown,
        fontSize: el.style.fontSize,
        fontFamily: toExFontFamily(el.style.fontFamily),
      };
      return sk;
    }
    // file/folder/region/image/suggestion/embed —— 非 Excalidraw 原生绘图类型。
    // 它们将由后续里程碑的 DOM 覆盖层渲染，不进 Excalidraw 场景。
    default:
      return null;
  }
}

function toExArrowhead(a: ArrowHead): ExArrowheadValue {
  // core ArrowHead: none/arrow/triangle/dot；Excalidraw: null/arrow/bar/dot/triangle
  if (a === 'none') return null;
  if (a === 'triangle') return 'triangle';
  if (a === 'dot') return 'dot';
  return 'arrow';
}

// ───────────────────────── Excalidraw → core ─────────────────────────

function fromExArrowhead(a: unknown): ArrowHead {
  if (a === 'triangle') return 'triangle';
  if (a === 'dot') return 'dot';
  if (a === 'bar') return 'arrow'; // core 无 bar，归一为 arrow
  if (a === 'arrow') return 'arrow';
  return 'none';
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
 * Excalidraw 元素 → core `Element`。
 *
 * @param ex    Excalidraw 元素
 * @param actor 当前参与者 id（写入 updatedBy）
 * @param prev  上一轮同 id 的 core 元素（若有）——用于保留 z / parentId / state /
 *              createdAt 等 Excalidraw 不持有的字段
 */
export function excalidrawToCore(
  ex: ExElement,
  actor: ParticipantId,
  prev?: Element,
): Element {
  const style = styleFromExcalidraw(ex);
  const env = coreEnvelope(ex, actor, prev, style);

  switch (ex.type) {
    case 'rectangle':
    case 'ellipse':
    case 'diamond': {
      const shape = ex.type as ShapeKind;
      const labelRaw = ex.customData?.['boardLabel'];
      const result: ShapeElement = {
        ...env,
        type: 'shape',
        shape,
        label:
          labelRaw && typeof labelRaw === 'object'
            ? (labelRaw as ShapeElement['label'])
            : prev?.type === 'shape'
              ? prev.label
              : null,
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
      const result: ConnectorElement = {
        ...env,
        type: 'connector',
        start: prevConn?.start ?? { elementId: null, anchor: 'auto' },
        end: prevConn?.end ?? { elementId: null, anchor: 'auto' },
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
