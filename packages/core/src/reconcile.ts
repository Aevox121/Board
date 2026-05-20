/**
 * 文件系统 → 画布 reconciliation — 见 specs/数据模型规格.md §5.7 / §9。
 *
 * 给定磁盘上 files/ 的文件列表，更新场景的 `file` 元素：
 *  - 新文件 → 创建 file 元素，按 §9 自动排版（落入所属区域或收件区）
 *  - 已消失的文件 → 移除对应 file 元素
 *
 * 纯函数，浏览器与 Node 通用。
 */
import type { BoardScene, Element, FileElement, ParticipantId } from './types.js';
import { regionsOf, regionForFile } from './fs-mapping.js';
import { createFileElement, nextZ } from './factory.js';
import {
  defaultSizeFor,
  nextSlot,
  regionContentSize,
  type Rect,
} from './layout.js';
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

  // 3. 各区域增长到能容纳其全部子元素（grow-only）——「区域必须包含所有内容」。
  const grown = growRegions(next);

  return {
    scene: { ...input.scene, elements: grown.elements },
    added,
    removed,
    changed: added.length > 0 || removed.length > 0 || grown.changed,
  };
}

/**
 * 让场景内每个区域增长到能容纳其全部子元素（grow-only，只增不减）。
 *
 * 只增不减：手动放大的区域不会被缩回；用户手动缩小另有内容下限（见 web 缩放）。
 *
 * @returns 新的元素数组与是否发生变化
 */
export function growRegions(elements: Element[]): {
  elements: Element[];
  changed: boolean;
} {
  let changed = false;
  const next = elements.map((r) => {
    if (r.type !== 'region') return r;
    const kids = elements.filter((e) => e.parentId === r.id);
    if (kids.length === 0) return r;
    const cs = regionContentSize(r, kids);
    const width = Math.max(r.width, cs.width);
    const height = Math.max(r.height, cs.height);
    if (width === r.width && height === r.height) return r;
    changed = true;
    return { ...r, width, height };
  });
  return { elements: next, changed };
}

/**
 * 手动「自动对齐」：把场景内所有 file 元素在其所属区域 / 收件区内重新网格排布。
 *
 * 与 reconcile 的新文件排布同构，但作用于全部文件 —— 供右键菜单「自动对齐」调用。
 * 平时拖拽文件**不**自动对齐（保留落点，类访达），仅用户显式触发本函数时才整理。
 *
 * 文件按当前位置（上→下、左→右）排序后逐个落入网格槽位，保留大致顺序。
 */
export function arrangeScene(scene: BoardScene): BoardScene {
  const regions = regionsOf(scene.elements);
  // 容器列表：收件区 + 各区域
  const containers: Array<{ id: string | null; rect: Rect }> = [
    { id: null, rect: INBOX_RECT },
    ...regions.map((r) => ({
      id: r.id,
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    })),
  ];

  const placed = new Map<string, { x: number; y: number }>();
  for (const container of containers) {
    const files = scene.elements
      .filter(
        (e): e is FileElement =>
          e.type === 'file' && (e.parentId ?? null) === container.id,
      )
      .sort((a, b) => a.y - b.y || a.x - b.x);
    const occupied: Rect[] = [];
    for (const f of files) {
      const size = { width: f.width, height: f.height };
      const pos = nextSlot(container.rect, occupied, size);
      placed.set(f.id, pos);
      occupied.push({ ...pos, width: size.width, height: size.height });
    }
  }
  if (placed.size === 0) return scene;

  const repositioned = scene.elements.map((e) => {
    const p = placed.get(e.id);
    return p ? ({ ...e, x: p.x, y: p.y, autoPlaced: true } as Element) : e;
  });
  const grown = growRegions(repositioned);
  return { ...scene, elements: grown.elements };
}
