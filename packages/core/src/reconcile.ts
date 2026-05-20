/**
 * 文件系统 → 画布 reconciliation — 见 specs/数据模型规格.md §5.7 / §9。
 *
 * 给定磁盘上 files/ 的文件列表，更新场景的 `file` 元素：
 *  - 新文件 → 创建 file 元素，按 §9 自动排版（落入所属区域或收件区）
 *  - 已消失的文件 → 移除对应 file 元素
 *
 * 纯函数，浏览器与 Node 通用。
 */
import type { BoardScene, FileElement, ParticipantId } from './types.js';
import { regionsOf, regionForFile } from './fs-mapping.js';
import { createFileElement, nextZ } from './factory.js';
import { defaultSizeFor, nextSlot, type Rect } from './layout.js';
import { guessMime } from './mime.js';

/** 收件区矩形 —— files/ 根下、不属于任何区域的游离文件的容器（§9.3）。 */
export const INBOX_RECT: Rect = { x: 0, y: 0, width: 720, height: 480 };

const MB = 1024 * 1024;

export interface ReconcileInput {
  scene: BoardScene;
  /** files/ 下现存文件的规范化相对路径 */
  diskFiles: string[];
  /** 各文件字节大小（path → size），可选 */
  sizes?: Record<string, number>;
  /** 操作者参与者 id */
  actor: ParticipantId;
  /** 预览大小上限（MB），超过的文件 previewable=false（PRD §6.4），默认 20 */
  previewLimitMB?: number;
}

export interface ReconcileResult {
  scene: BoardScene;
  /** 新增 file 元素的路径 */
  added: string[];
  /** 移除的文件路径 */
  removed: string[];
  /** 场景是否发生变化 */
  changed: boolean;
}

/** 把磁盘文件列表 reconcile 进场景，返回新场景与变更摘要。 */
export function reconcileFiles(input: ReconcileInput): ReconcileResult {
  const { diskFiles, sizes, actor } = input;
  const limitBytes = (input.previewLimitMB ?? 20) * MB;
  const diskSet = new Set(diskFiles);

  const elements = [...input.scene.elements];
  const regions = regionsOf(elements);

  // 已有 file 元素的 path 集合
  const existingFilePaths = new Set<string>();
  for (const el of elements) {
    if (el.type === 'file') existingFilePaths.add(el.path);
  }

  const added: string[] = [];
  const removed: string[] = [];

  // 1. 移除磁盘上已不存在的 file 元素
  let next = elements.filter((el) => {
    if (el.type === 'file' && !diskSet.has(el.path)) {
      removed.push(el.path);
      return false;
    }
    return true;
  });

  // 2. 为新文件创建 file 元素并自动排版
  for (const path of diskFiles) {
    if (existingFilePaths.has(path)) continue;

    const region = regionForFile(path, regions);
    const parentId = region ? region.id : null;
    const container: Rect = region
      ? { x: region.x, y: region.y, width: region.width, height: region.height }
      : INBOX_RECT;

    // 容器内已占据的矩形（碰撞规避）
    const occupied: Rect[] = next
      .filter((e) => e.parentId === parentId)
      .map((e) => ({ x: e.x, y: e.y, width: e.width, height: e.height }));

    const size = defaultSizeFor('file', 'card');
    const pos = nextSlot(container, occupied, size);
    const fileSize = sizes?.[path] ?? 0;

    const el: FileElement = createFileElement({
      x: pos.x,
      y: pos.y,
      width: size.width,
      height: size.height,
      createdBy: actor,
      parentId,
      autoPlaced: true,
      z: nextZ(next),
      path,
      mime: guessMime(path),
      size: fileSize,
    });
    el.previewable = fileSize <= limitBytes;

    next.push(el);
    added.push(path);
  }

  return {
    scene: { ...input.scene, elements: next },
    added,
    removed,
    changed: added.length > 0 || removed.length > 0,
  };
}
