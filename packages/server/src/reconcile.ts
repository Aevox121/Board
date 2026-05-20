/**
 * 文件系统 → 画布 reconcile 协调器 — 见 specs/数据模型规格.md §5.7 / §9。
 *
 * 把 @board/core 的纯函数 `reconcileFiles` 接到 Node 侧的真实 IO：
 *  - 用 `listBoardFiles` 取磁盘文件列表
 *  - 用 `node:fs` stat 各文件字节大小
 *  - `loadBoard` → `reconcileFiles` → 若 changed 则 `saveBoard`
 *
 * watcher 的文件增删改事件经此模块触发一次 reconcile；
 * 防抖在 index.ts 装配层完成，本模块每次调用即执行一次完整 reconcile。
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { reconcileFiles, type ParticipantId } from '@board/core';
import { listBoardFiles, loadBoard, saveBoard } from '@board/core/node';

/** 一次 reconcile 的结果摘要。 */
export interface ReconcileRunResult {
  /** 场景或可见文件状态是否发生变化（变化才会 saveBoard + 广播） */
  changed: boolean;
  /** 新增 file 元素的路径 */
  added: string[];
  /** 被移动 / 改名的文件新路径（移动检测命中） */
  moved: string[];
  /** 仍指向不存在文件的 file 元素路径（R6 缺失态） */
  missing: string[];
}

/**
 * 对一个白板目录执行一次完整 reconcile。
 *
 * @param dir    .board 目录绝对路径
 * @param actor  操作者参与者 id（文件系统触发的变更用固定系统身份）
 * @returns      reconcile 结果摘要；失败时抛错由调用方处理
 */
export async function runReconcile(
  dir: string,
  actor: ParticipantId,
): Promise<ReconcileRunResult> {
  // 1. 加载当前白板（meta + scene）
  const handle = await loadBoard(dir);

  // 2. 扫描磁盘 files/ 文件列表（已剔除 R7 忽略项）
  const diskFiles = await listBoardFiles(dir);

  // 3. stat 各文件字节大小；单个文件 stat 失败按 0 处理，不中断整体
  const filesRoot = join(dir, 'files');
  const sizes: Record<string, number> = {};
  await Promise.all(
    diskFiles.map(async (rel) => {
      try {
        const st = await stat(join(filesRoot, rel));
        sizes[rel] = st.size;
      } catch {
        sizes[rel] = 0;
      }
    }),
  );

  // 4. 纯函数 reconcile：算出新场景
  const result = reconcileFiles({
    scene: handle.scene,
    diskFiles,
    sizes,
    actor,
    previewLimitMB: handle.meta.settings.previewSizeLimitMB,
  });

  // 5. 仅在场景变化时落盘
  if (result.changed) {
    await saveBoard(dir, handle.meta, result.scene);
  }

  return {
    changed: result.changed,
    added: result.added,
    moved: result.moved,
    missing: result.missing,
  };
}
