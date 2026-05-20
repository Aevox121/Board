/**
 * 样式字段桥接 — core `Style` ⇄ Excalidraw 元素的样式相关字段。
 *
 * 映射关系：
 * | core Style          | Excalidraw 字段                    | 备注 |
 * |---------------------|------------------------------------|------|
 * | strokeColor         | strokeColor                        | 直传 |
 * | backgroundColor     | backgroundColor                    | `'transparent'` 直传 |
 * | fillStyle           | fillStyle                          | core 的 `none` Excalidraw 无对应 → 落 `solid`（配透明底） |
 * | strokeWidth         | strokeWidth                        | 直传 |
 * | strokeStyle         | strokeStyle                        | 直传（枚举一致） |
 * | roughness           | roughness                          | 直传 |
 * | opacity             | opacity                            | 同为 0–100 |
 * | cornerRadius        | roundness                          | >0 → `{type:3,value}`；0 → null |
 * | fontFamily/fontSize | 见 element.ts 内 text 转换          | 通用 envelope 不含字体，仅 text/label 用 |
 */
import type { Style, FillStyle as CoreFillStyle } from '@board/core';
import { makeDefaultStyle } from '@board/core';
import type { ExElement } from './types';

/** Excalidraw 圆角类型常量（constants.ts ROUNDNESS.ADAPTIVE_RADIUS = 3）。 */
const ROUNDNESS_ADAPTIVE = 3;

/** core `fillStyle` → Excalidraw `fillStyle`。Excalidraw 无 `none`，退化为 `solid`。 */
function toExFillStyle(fill: CoreFillStyle): ExElement['fillStyle'] {
  if (fill === 'none') return 'solid';
  return fill;
}

/** Excalidraw `fillStyle` → core `fillStyle`。Excalidraw 的 `zigzag` core 无对应 → `hachure`。 */
function toCoreFillStyle(fill: ExElement['fillStyle']): CoreFillStyle {
  if (fill === 'zigzag') return 'hachure';
  return fill;
}

/** core Style 中作用于 Excalidraw 元素 envelope 的样式字段子集。 */
export interface ExStyleFields {
  strokeColor: string;
  backgroundColor: string;
  fillStyle: ExElement['fillStyle'];
  strokeWidth: number;
  strokeStyle: ExElement['strokeStyle'];
  roughness: number;
  opacity: number;
  roundness: ExElement['roundness'];
}

/** core Style → Excalidraw 元素样式字段。 */
export function styleToExcalidraw(style: Style): ExStyleFields {
  return {
    strokeColor: style.strokeColor,
    backgroundColor: style.backgroundColor,
    fillStyle: toExFillStyle(style.fillStyle),
    strokeWidth: style.strokeWidth,
    strokeStyle: style.strokeStyle,
    roughness: style.roughness,
    opacity: style.opacity,
    roundness:
      style.cornerRadius > 0
        ? { type: ROUNDNESS_ADAPTIVE, value: style.cornerRadius }
        : null,
  };
}

/**
 * Excalidraw 元素样式字段 → core Style。
 * `fontFamily`/`fontSize` 由调用方按元素类型补充（text/label 才有），
 * 此处用默认值占位。
 */
export function styleFromExcalidraw(el: ExElement): Style {
  const base = makeDefaultStyle();
  return {
    ...base,
    strokeColor: el.strokeColor,
    backgroundColor: el.backgroundColor,
    fillStyle: toCoreFillStyle(el.fillStyle),
    strokeWidth: el.strokeWidth,
    strokeStyle: el.strokeStyle,
    roughness: el.roughness,
    opacity: el.opacity,
    // Excalidraw roundness 是 {type,value?}，value 常为空（自适应半径）；
    // 取不到具体值时回落到默认 cornerRadius。
    cornerRadius:
      el.roundness == null ? 0 : (el.roundness.value ?? base.cornerRadius),
  };
}
