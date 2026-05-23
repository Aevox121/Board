/**
 * 文件系统 → 画布 reconcile 协调器 — 见 specs/数据模型规格.md §5.7 / §9。
 *
 * 把 @board/core 的纯函数 `reconcileFiles` 接到 Node 侧的真实 IO：
 *  - 用 `listBoardFiles` 取磁盘文件列表
 *  - 用 `node:fs` stat 各文件字节大小
 *  - 据传入的 scene 算出新场景（**不再 load/save board.json**，调用方拿
 *    着新场景经 yjs-room 写入；M4 后 Y.Doc 为权威源）
 *
 * watcher 的文件增删改事件经此模块触发一次 reconcile；
 * 防抖在 index.ts 装配层完成，本模块每次调用即执行一次完整 reconcile。
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  reconcileFiles,
  type BoardScene,
  type ParticipantId,
} from '@board/core';
import { listBoardFiles } from '@board/core/node';

/** 一次 reconcile 的结果摘要 + 算出的新场景。 */
export interface ReconcileRunResult {
  /** 场景或可见文件状态是否发生变化（变化才需写回 Y.Doc + 广播） */
  changed: boolean;
  /** 新增 file 元素的路径 */
  added: string[];
  /** 被移动 / 改名的文件新路径（移动检测命中） */
  moved: string[];
  /** 仍指向不存在文件的 file 元素路径（R6 缺失态） */
  missing: string[];
  /** 新场景（未变化时即 opts.scene 原引用） */
  scene: BoardScene;
  /** 本次磁盘扫描的全部 files/ 相对路径（已剔除 R7 忽略项）—— 调用方可用于
   * 同步 watcher 缓存，消除 chokidar 轮询窗口期内 getFiles() 与刚 reconcile
   * 出的场景之间的不一致。 */
  diskFiles: string[];
}

export interface RunReconcileOptions {
  dir: string;
  scene: BoardScene;
  previewLimitMB: number;
  actor: ParticipantId;
}

/**
 * 对一个白板目录执行一次完整 reconcile（仅算，不写）。
 *
 * @returns      reconcile 结果 + 新场景；调用方按 changed 决定是否
 *               room.mutate(scene) + recordChange。失败抛错。
 */
export async function runReconcile(
  opts: RunReconcileOptions,
): Promise<ReconcileRunResult> {
  // 1. 扫描磁盘 files/ 文件列表（已剔除 R7 忽略项）
  const diskFiles = await listBoardFiles(opts.dir);

  // 2. stat 各文件字节大小；单个文件 stat 失败按 0 处理，不中断整体
  const filesRoot = join(opts.dir, 'files');
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

  // 3. 纯函数 reconcile：算出新场景
  const result = reconcileFiles({
    scene: opts.scene,
    diskFiles,
    sizes,
    actor: opts.actor,
    previewLimitMB: opts.previewLimitMB,
  });

  return {
    changed: result.changed,
    added: result.added,
    moved: result.moved,
    missing: result.missing,
    scene: result.changed ? result.scene : opts.scene,
    diskFiles,
  };
}
