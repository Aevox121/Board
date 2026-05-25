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
  /** 命中「移动检测」而被改名 / 移动的文件新路径（R5：更新元素 path，不删旧建新） */
  moved: string[];
  /** 仍指向不存在文件的 file 元素路径（R6 缺失态，元素保留不删除） */
  missing: string[];
  /**
   * 场景或可见文件状态是否变化。为 true 时调用方应 saveBoard 并广播刷新——
   * 包括存在缺失文件的情况：场景字节虽未变，但客户端需据最新文件列表渲染缺失态。
   */
  changed: boolean;
}

/** 取相对路径末段（文件名）—— 移动检测按同名配对消失元素与新文件。 */
function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

/**
 * 把磁盘文件列表 reconcile 进场景，返回新场景与变更摘要。
 *
 * 流程：
 *  1. 移动检测——把「磁盘上消失的 file 元素」与「尚无元素的新文件」配对：
 *     命中即视为文件被改名 / 移动，更新元素 `path`、`parentId`（R5 路径即真相，
 *     不删旧建新）。同名优先配对；最后剩 1 对 1 也配对（覆盖纯改名）。
 *  2. 未配对的新文件 → 新建 file 元素并自动排版。
 *  3. 被移动的元素重新落位到（新）容器。
 *  4. 未配对的消失元素 → **不删除**，保留为「缺失」渲染态（R6），等待恢复或清理。
 *  5. 各区域 grow-only 增长以容纳全部子元素。
 */
export function reconcileFiles(input: ReconcileInput): ReconcileResult {
  const { diskFiles, sizes, actor } = input;
  const limitBytes = (input.previewLimitMB ?? 20) * MB;
  const diskSet = new Set(diskFiles);

  const elements = [...input.scene.elements];
  const regions = regionsOf(elements);

  // 现有 file 元素及其 path 集合
  const fileEls = elements.filter((e): e is FileElement => e.type === 'file');
  const existingFilePaths = new Set(fileEls.map((e) => e.path));

  // 两侧待处理：磁盘上已消失的 file 元素 / 尚无对应元素的磁盘新文件
  const goneEls = fileEls.filter((e) => !diskSet.has(e.path));
  const newPaths = diskFiles.filter((p) => !existingFilePaths.has(p));

  // ── 1. 移动检测：消失元素 ↔ 新文件 配对 ─────────────────────────
  const pendingNew = [...newPaths];
  const moveTo = new Map<string, string>(); // file 元素 id → 新 path
  for (const g of goneEls) {
    const base = baseName(g.path);
    const idx = pendingNew.findIndex((p) => baseName(p) === base);
    if (idx < 0) continue;
    const [match] = pendingNew.splice(idx, 1);
    if (match !== undefined) moveTo.set(g.id, match);
  }
  // 同名配对后仍各剩 1 个 → 视为纯改名，也配对。
  const unpairedGone = goneEls.filter((g) => !moveTo.has(g.id));
  const lastGone = unpairedGone[0];
  const lastNew = pendingNew[0];
  if (
    unpairedGone.length === 1 &&
    pendingNew.length === 1 &&
    lastGone &&
    lastNew !== undefined
  ) {
    moveTo.set(lastGone.id, lastNew);
    pendingNew.splice(0, 1);
  }

  // ── 2. 应用移动：更新被移动元素的 path / parentId（位置稍后重排）─────
  const ts = new Date().toISOString();
  const moved: string[] = [];
  const next: Element[] = elements.map((el) => {
    if (el.type !== 'file') return el;
    const to = moveTo.get(el.id);
    if (to === undefined) return el;
    moved.push(to);
    const region = regionForFile(to, regions);
    return {
      ...el,
      path: to,
      parentId: region ? region.id : null,
      updatedBy: actor,
      updatedAt: ts,
    };
  });

  // ── 3. 为未配对的新文件创建 file 元素并自动排版 ─────────────────
  const added: string[] = [];
  for (const path of pendingNew) {
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

  // ── 4. 被移动的元素重新落位到（新）容器 —— CLI mv 的「自动归位」───────
  for (const id of moveTo.keys()) {
    const idx = next.findIndex((e) => e.id === id);
    if (idx < 0) continue;
    const el = next[idx];
    if (!el) continue;
    const region = regions.find((r) => r.id === el.parentId);
    const container: Rect = region
      ? { x: region.x, y: region.y, width: region.width, height: region.height }
      : INBOX_RECT;
    const occupied: Rect[] = next
      .filter((e, i) => i !== idx && e.parentId === el.parentId)
      .map((e) => ({ x: e.x, y: e.y, width: e.width, height: e.height }));
    const pos = nextSlot(container, occupied, {
      width: el.width,
      height: el.height,
    });
    next[idx] = { ...el, x: pos.x, y: pos.y, autoPlaced: true };
  }

  // ── 4.5 元数据回填 —— 凡 path 在 diskSet 的 file 元素，mime 与 size 均
  // 重新按 guessMime(path) / sizes[path] 校正一遍。早期 bug 可能让某些元素
  // 留下过期 mime（如 plain 应为 markdown）；这里顺势刷新。
  let metaRefreshed = false;
  for (let i = 0; i < next.length; i += 1) {
    const el = next[i];
    if (!el || el.type !== 'file') continue;
    if (!diskSet.has(el.path)) continue;
    const wantMime = guessMime(el.path);
    const wantSize = sizes?.[el.path] ?? el.size;
    const wantPreviewable = wantSize <= limitBytes;
    if (
      el.mime !== wantMime ||
      el.size !== wantSize ||
      el.previewable !== wantPreviewable
    ) {
      next[i] = {
        ...el,
        mime: wantMime,
        size: wantSize,
        previewable: wantPreviewable,
        updatedBy: actor,
        updatedAt: ts,
      };
      metaRefreshed = true;
    }
  }

  // ── 5. 同 path 去重 —— 防御性补丁（PRD §5.7 路径即真相）。──────────
  // 历史 bug 可能在场景里留下多个同 path 的 file 元素（典型：早期版本的移动
  // 检测仅按 baseName 匹配，扩展名变化的改名 → 旧元素未配对 → 新元素被
  // 当作「新文件」创建，旧元素留作 R6 缺失，后续又被某次拖拽改回相同 path
  // → 双份并存）。reconcile 是把场景拉回「fs 真相」的最后机会，这里顺带把
  // 同 path 多份压缩成一份。
  //
  // 保留谁的优先级（从高到低）：
  //  1) mime 跟当前 path 扩展名匹配的（其他大概是历史快照，留了过期 mime）
  //  2) createdAt 较晚 —— 新建的通常承载用户最近的尺寸 / 位置编辑
  //  3) updatedAt 较晚（兜底）
  //  4) id 字典序（绝对稳定的 tiebreaker）
  const dropped = new Set<string>();
  const byPath = new Map<string, FileElement>();
  /** 返回 a 是否「更应保留」（即 a 优于 b）。 */
  const prefer = (a: FileElement, b: FileElement): boolean => {
    const want = guessMime(a.path);
    const aHit = a.mime === want;
    const bHit = b.mime === want;
    if (aHit !== bHit) return aHit;
    const aC = Date.parse(a.createdAt ?? '') || 0;
    const bC = Date.parse(b.createdAt ?? '') || 0;
    if (aC !== bC) return aC > bC;
    const aU = Date.parse(a.updatedAt ?? '') || 0;
    const bU = Date.parse(b.updatedAt ?? '') || 0;
    if (aU !== bU) return aU > bU;
    return a.id > b.id;
  };
  for (const el of next) {
    if (el.type !== 'file') continue;
    const cur = byPath.get(el.path);
    if (!cur) {
      byPath.set(el.path, el);
      continue;
    }
    if (prefer(el, cur)) {
      dropped.add(cur.id);
      byPath.set(el.path, el);
    } else {
      dropped.add(el.id);
    }
  }
  const deduped =
    dropped.size > 0 ? next.filter((e) => !dropped.has(e.id)) : next;

  // ── 6. 各区域增长到能容纳其全部子元素（grow-only）─────────────────
  // 注：消失但未配对的 file 元素已留在 deduped 中（R6 缺失态），不删除。
  const grown = growRegions(deduped);

  // 仍指向不存在文件的元素 —— 移动检测后未被配对的「消失元素」即缺失态。
  // 已被 dedupe 丢弃的不算缺失。
  const missing = goneEls
    .filter((g) => !moveTo.has(g.id) && !dropped.has(g.id))
    .map((g) => g.path);

  return {
    scene: { ...input.scene, elements: grown.elements },
    added,
    moved,
    missing,
    // 缺失文件存在 / dedupe 丢弃过元素 / 元数据回填都算 changed —— 场景
    // 字节有变化，需广播让客户端拉取最新文件列表 / 重渲染。
    changed:
      added.length > 0 ||
      moved.length > 0 ||
      grown.changed ||
      missing.length > 0 ||
      dropped.size > 0 ||
      metaRefreshed,
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

/** `arrangeScene` 的作用域选项 —— 不给则整理全部容器的全部卡片元素。 */
export interface ArrangeOptions {
  /**
   * 限定只整理这些容器：传 region id，或 `null` 表示收件区。
   * 不给 = 所有容器（收件区 + 全部区域）。
   */
  containers?: ReadonlyArray<string | null>;
  /**
   * 限定只重排这些卡片元素 id（file/text/folder/image/embed）；
   * 其余同容器卡片保持原位但计入碰撞占位。
   * 不给 = 容器内全部卡片参与重排。
   */
  fileIds?: ReadonlySet<string>;
}

/**
 * 「卡片型元素」—— 整理时按矩形网格落位的元素集合。
 * file/text/folder/image/embed 均有内容矩形，可与文件卡同款网格排布。
 * shape/draw/connector/region/suggestion 排除（自由图形 / 容器 / 协作元素）。
 */
const CARD_TYPES: ReadonlySet<Element['type']> = new Set<Element['type']>([
  'file',
  'text',
  'folder',
  'image',
  'embed',
]);
function isCardElement(e: Element): boolean {
  return CARD_TYPES.has(e.type);
}

/**
 * 手动「自动对齐」：把 file 元素在其所属区域 / 收件区内重新网格排布。
 *
 * 平时拖拽文件**不**自动对齐（保留落点，类访达），仅用户经右键菜单显式触发
 * 本函数时才整理。文件按当前位置（上→下、左→右）排序后逐个落入网格槽位，
 * 保留大致顺序。
 *
 * 作用域（`opts`）：
 *  - 不给 —— 整理所有容器的所有文件。
 *  - `containers` —— 只整理指定区域 / 收件区（右键区域 / 白板背景）。
 *  - `fileIds` —— 只重排指定文件（右键框选）；同容器内未选中的文件视为占位。
 */
export function arrangeScene(
  scene: BoardScene,
  opts?: ArrangeOptions,
): BoardScene {
  const regions = regionsOf(scene.elements);
  // 全部容器：收件区(null) + 各区域
  const allContainers: Array<{ id: string | null; rect: Rect }> = [
    { id: null, rect: INBOX_RECT },
    ...regions.map((r) => ({
      id: r.id,
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    })),
  ];
  const containerFilter = opts?.containers ? new Set(opts.containers) : null;
  const containers = containerFilter
    ? allContainers.filter((c) => containerFilter.has(c.id))
    : allContainers;
  const fileIds = opts?.fileIds ?? null;

  const placed = new Map<string, { x: number; y: number }>();
  for (const container of containers) {
    const cards = scene.elements.filter(
      (e) => isCardElement(e) && (e.parentId ?? null) === container.id,
    );
    // 本次要重排的卡片；不给 fileIds 则容器内全部参与。
    const toMove = fileIds ? cards.filter((f) => fileIds.has(f.id)) : cards;
    if (toMove.length === 0) continue;
    // 占位：本容器内不重排的卡片保持原位、计入碰撞规避。
    const moveSet = new Set(toMove.map((f) => f.id));
    const occupied: Rect[] = cards
      .filter((f) => !moveSet.has(f.id))
      .map((f) => ({ x: f.x, y: f.y, width: f.width, height: f.height }));
    // 待重排卡片按当前位置排序，保留大致顺序。
    const sorted = [...toMove].sort((a, b) => a.y - b.y || a.x - b.x);
    for (const f of sorted) {
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
