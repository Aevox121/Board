/**
 * 统一样式默认值与工具 — 见 specs/数据模型规格.md §5。
 */
import type { Style } from './types';

/** 新元素的默认样式（Excalidraw 手绘风格基调）。 */
export const DEFAULT_STYLE: Style = {
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  fillStyle: 'none',
  strokeWidth: 2,
  strokeStyle: 'solid',
  roughness: 1,
  opacity: 100,
  cornerRadius: 8,
  fontFamily: 'hand',
  fontSize: 20,
};

/** 返回默认样式的独立副本。 */
export const makeDefaultStyle = (): Style => ({ ...DEFAULT_STYLE });

/** 合并样式补丁，得到新的 Style（不可变）。 */
export function mergeStyle(base: Style, patch: Partial<Style>): Style {
  return { ...base, ...patch };
}
