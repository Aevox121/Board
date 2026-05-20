/**
 * Excalidraw ⇄ @board/core 桥接层 — 共用类型别名。
 *
 * Excalidraw 的元素类型从其内部 .d.ts 暴露，但包入口未直接 re-export
 * `ExcalidrawElement`，因此这里集中做类型导入与窄化，桥接其余文件统一引用本文件。
 */
import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types';

/** Excalidraw 单个元素（含 isDeleted 等运行时字段，所有字段只读）。 */
export type ExElement = ExcalidrawElement;

/** Excalidraw 元素 type 字段。 */
export type ExElementType = ExElement['type'];

/** Excalidraw 线性/手绘元素的点坐标（[x,y] 数对）。 */
export type ExPoint = readonly [number, number];

/** Excalidraw 箭头端点样式（element/types.d.ts Arrowhead 联合）。 */
export type ExArrowheadValue = 'arrow' | 'bar' | 'dot' | 'triangle' | null;

/**
 * 构造 Excalidraw 元素时的「骨架」。
 *
 * `Partial<ExcalidrawElement>`（union 不分布）只剩共有字段，会丢掉 `points` /
 * `text` / `startArrowhead` 等子类型专属字段；各子类型 partial 的交集又因
 * `type` 字面量冲突坍缩成 `never`。因此这里显式声明一个宽松骨架接口，
 * 列出 M1 桥接实际写入的字段——`type/x/y` 必填，其余可选。
 * 缺失字段（seed / version / versionNonce / updated 等）由 `restoreElements` 补全。
 */
export interface ExElementSkeleton {
  type: ExElementType;
  x: number;
  y: number;
  id?: string;
  width?: number;
  height?: number;
  angle?: number;
  locked?: boolean;
  /** 样式字段 */
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: ExElement['fillStyle'];
  strokeWidth?: number;
  strokeStyle?: ExElement['strokeStyle'];
  roughness?: number;
  opacity?: number;
  roundness?: ExElement['roundness'];
  /** 线性 / 手绘元素 */
  points?: ExPoint[];
  pressures?: number[];
  startArrowhead?: ExArrowheadValue;
  endArrowhead?: ExArrowheadValue;
  /** 文本元素 */
  text?: string;
  fontSize?: number;
  fontFamily?: number;
  /** 扩展位 */
  customData?: Record<string, unknown>;
  /** 其余 Excalidraw 字段（还原未知类型时直传），交给 restoreElements 消化。 */
  [extra: string]: unknown;
}
