/**
 * 命令侧自动落位辅助 —— 无 `--at` 时按碰撞规避网格找空位。
 *
 * 复用 @board/core 的 `nextSlot`：在容器（区域 / 收件区）内逐格扫描，
 * 跳过已被占据的位置，给新元素一个不与同容器现有元素重叠的坐标。
 */
import { nextSlot, placeNearAnchor, type Element } from '@board/core';

/** 轴对齐矩形。 */
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 为新元素在容器内找一个不与同容器现有元素重叠的网格空位。
 *
 * @param elements  场景全部元素
 * @param parentId  目标容器（region id；`null` = 收件区）
 * @param container 容器矩形
 * @param size      新元素尺寸
 */
export function autoPlace(
  elements: readonly Element[],
  parentId: string | null,
  container: Rect,
  size: { width: number; height: number },
): { x: number; y: number } {
  const occupied: Rect[] = elements
    .filter((e) => (e.parentId ?? null) === parentId)
    .map((e) => ({ x: e.x, y: e.y, width: e.width, height: e.height }));
  return nextSlot(container, occupied, size);
}

/**
 * M5 L2：锚点优先的防重叠落位 —— `--at` 不再硬摆，作为「锚点偏好」喂给引擎，
 * 被占则网格行优先外扩到最近空位。返回 `{x, y, nudged}`：nudged 表示被挪动过。
 *
 * @param elements  场景全部元素
 * @param parentId  目标容器（region id；`null` = 顶层 / 收件区）
 * @param anchor    锚点坐标（来自 `--at`）
 * @param size      新元素尺寸
 * @param maxRowWidth 单行外扩宽度（region 内传区域内宽，顶层用默认）
 */
export function autoPlaceNear(
  elements: readonly Element[],
  parentId: string | null,
  anchor: { x: number; y: number },
  size: { width: number; height: number },
  maxRowWidth?: number,
): { x: number; y: number; nudged: boolean } {
  const occupied: Rect[] = elements
    .filter((e) => (e.parentId ?? null) === parentId)
    .map((e) => ({ x: e.x, y: e.y, width: e.width, height: e.height }));
  const pos = placeNearAnchor(occupied, size, anchor, { maxRowWidth });
  return { ...pos, nudged: pos.x !== anchor.x || pos.y !== anchor.y };
}
