/**
 * 场景元素删除 —— 移除一个元素，并连带清理对它的悬空引用。
 *
 * 删除一个元素时，引用它的「连线」（端点指向它）与「建议」（targetId 指向
 * 它）会变成悬空引用，故一并移除。CLI `board rm`、server `POST
 * /api/elements/delete`、Web 画布删除三处共用本函数，保证删除语义一致
 * （specs/CLI与MCP规格.md §2.2）。
 *
 * 注意：本函数只处理场景数据；`file` 元素背后真实文件的回收站迁移由调用方
 * （持有文件系统访问权的 CLI / server）各自处理。
 */
import type { BoardScene, Element } from './types.js';

/** `removeElement` 的结果。 */
export interface RemoveElementResult {
  /** 删除后的新场景（目标不存在时为原场景）。 */
  scene: BoardScene;
  /** 是否真的有元素被移除（目标不存在时为 false）。 */
  removed: boolean;
  /** 连带清理掉的引用元素 id（指向被删元素的连线 / 建议）。 */
  removedRefs: string[];
}

/**
 * 从场景中移除 `id` 指定的元素，并连带清理引用它的连线 / 建议。
 * 目标元素不存在时原样返回（`removed: false`）。
 */
export function removeElement(
  scene: BoardScene,
  id: string,
): RemoveElementResult {
  let removed = false;
  const removedRefs: string[] = [];
  const elements = scene.elements.filter((e: Element) => {
    if (e.id === id) {
      removed = true;
      return false;
    }
    if (
      e.type === 'connector' &&
      (e.start.elementId === id || e.end.elementId === id)
    ) {
      removedRefs.push(e.id);
      return false;
    }
    if (e.type === 'suggestion' && e.targetId === id) {
      removedRefs.push(e.id);
      return false;
    }
    return true;
  });
  // 目标不存在 —— 不动场景，也不连带清理（避免误删孤儿引用）。
  if (!removed) {
    return { scene, removed: false, removedRefs: [] };
  }
  return { scene: { ...scene, elements }, removed: true, removedRefs };
}
