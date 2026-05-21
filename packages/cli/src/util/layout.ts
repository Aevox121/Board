/**
 * 命令侧自动落位辅助 —— 无 `--at` 时按碰撞规避网格找空位。
 *
 * 复用 @board/core 的 `nextSlot`：在容器（区域 / 收件区）内逐格扫描，
 * 跳过已被占据的位置，给新元素一个不与同容器现有元素重叠的坐标。
 */
import { nextSlot, type Element } from '@board/core';

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
