/**
 * BoardScene ↔ Yjs 文档双向镜像（PRD §7 M4 实时同步工作包）。
 *
 * Y.Doc 结构:
 *   - viewport      : Y.Map { x, y, zoom }
 *   - elements      : Y.Map<elementId, Y.Map>   每元素一张 Y.Map
 *   - elementOrder  : Y.Array<elementId>        BoardScene.elements 数组顺序
 *
 * 字段映射规则:
 *   - 标量字段(number / string / boolean / null)→ Y.Map 槽直接 set
 *   - 嵌套对象(style / shape.label / connector.label / Endpoint)→ Y.Map
 *     —— 字段级 CRDT 合并(两人同时改不同字段都保留)
 *   - 文字字段 → Y.Text(字符级 CRDT,两人同时打字字符级合并):
 *       text.markdown / region.label / region.description /
 *       shape.label.text / connector.label.text
 *   - 数组与 record(points / pressures / waypoints / groupIds /
 *     comments / thread / meta / suggestion.payload)→ 以下:
 *       · suggestion.payload 嵌套 Element → 递归 elementToYMap
 *       · 其余按不可变值整体 set(Board 场景下不需要更细粒度)
 *
 * 撤销 / 重做：按你 2026-05-23 拍板「先单端」,栈在 BoardContext 维护,
 * 不在本文件涉及。
 */
import * as Y from 'yjs';
import type { BoardScene, Element } from './types.js';
import { SCHEMA_VERSION } from './types.js';

/** 顶层 Y.Text 字段（按元素类型）。 */
const TOP_TEXT_FIELDS: Partial<Record<string, ReadonlySet<string>>> = {
  text: new Set(['markdown']),
  region: new Set(['label', 'description']),
};

/** 嵌套 Y.Map 字段（按元素类型）—— 槽里放 Y.Map 而非原始对象。 */
const NESTED_MAP_FIELDS: Partial<Record<string, ReadonlySet<string>>> = {
  draw: new Set(['style']),
  shape: new Set(['style', 'label']),
  connector: new Set(['style', 'label', 'start', 'end']),
  text: new Set(['style']),
  file: new Set(['style']),
  folder: new Set(['style']),
  region: new Set(['style']),
  image: new Set(['style']),
  suggestion: new Set(['style']),
  embed: new Set(['style']),
};

/** 把一个 Element 字段写进给定 Y.Map（就地，幂等覆盖）。 */
function fillYMapFromElement(m: Y.Map<unknown>, el: Element): void {
  const type = el.type;
  const textFields = TOP_TEXT_FIELDS[type] ?? new Set<string>();
  const mapFields = NESTED_MAP_FIELDS[type] ?? new Set<string>();
  for (const [key, value] of Object.entries(el)) {
    if (textFields.has(key) && typeof value === 'string') {
      // 顶层 Y.Text(region.label/description、text.markdown)
      const t = new Y.Text();
      m.set(key, t);
      if (value.length > 0) t.insert(0, value);
      continue;
    }
    if (mapFields.has(key)) {
      if (value === null || value === undefined) {
        // label 可为 null —— 保留 null 语义
        m.set(key, value as null);
        continue;
      }
      if (typeof value !== 'object') {
        m.set(key, value);
        continue;
      }
      const child = new Y.Map<unknown>();
      m.set(key, child);
      if (key === 'label' && (type === 'shape' || type === 'connector')) {
        // { text: string, fontSize?: number } —— text 升 Y.Text
        const lo = value as { text: string; fontSize?: number };
        const lt = new Y.Text();
        child.set('text', lt);
        if (lo.text.length > 0) lt.insert(0, lo.text);
        if (typeof lo.fontSize === 'number') child.set('fontSize', lo.fontSize);
      } else {
        // style / Endpoint(start/end)—— 一律标量场,直接搬运
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          child.set(k, v);
        }
      }
      continue;
    }
    if (key === 'payload' && type === 'suggestion' && value && typeof value === 'object') {
      // suggestion.payload 是嵌套 Element —— 递归镜像
      const pm = new Y.Map<unknown>();
      m.set(key, pm);
      fillYMapFromElement(pm, value as Element);
      continue;
    }
    // 普通标量 / 数组 / record —— 整体 set,不参与内部 CRDT 合并
    m.set(key, value);
  }
}

/** 单元素 → Y.Map（脱离任何 Doc，调用方再挂载到 elements Y.Map 上）。 */
export function elementToYMap(el: Element): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  fillYMapFromElement(m, el);
  return m;
}

/** Y.Map → 纯 JS Element（深拷贝，与原元素深等于）。 */
export function yMapToElement(m: Y.Map<unknown>): Element {
  const result: Record<string, unknown> = {};
  for (const key of Array.from(m.keys())) {
    const v = m.get(key);
    if (v instanceof Y.Text) {
      result[key] = v.toString();
    } else if (v instanceof Y.Array) {
      result[key] = v.toArray();
    } else if (v instanceof Y.Map) {
      if (key === 'payload') {
        result[key] = yMapToElement(v as Y.Map<unknown>);
      } else if (key === 'label') {
        // shape/connector label: { text: Y.Text, fontSize?: number }
        const text = v.get('text');
        const obj: Record<string, unknown> = {
          text: text instanceof Y.Text ? text.toString() : String(text ?? ''),
        };
        const fs = v.get('fontSize');
        if (typeof fs === 'number') obj.fontSize = fs;
        result[key] = obj;
      } else {
        // style / start / end —— 平铺标量
        const obj: Record<string, unknown> = {};
        for (const k of Array.from(v.keys())) {
          obj[k] = v.get(k);
        }
        result[key] = obj;
      }
    } else {
      result[key] = v;
    }
  }
  return result as unknown as Element;
}

/**
 * BoardScene → Y.Doc（产新 Doc）。
 * 调用方一般在 server 启动时按 board.json 构 Doc，之后 Doc 即权威源。
 */
export function sceneToYDoc(scene: BoardScene): Y.Doc {
  const doc = new Y.Doc();
  const vp = doc.getMap<number>('viewport');
  vp.set('x', scene.viewport.x);
  vp.set('y', scene.viewport.y);
  vp.set('zoom', scene.viewport.zoom);
  const elements = doc.getMap<Y.Map<unknown>>('elements');
  const order = doc.getArray<string>('elementOrder');
  doc.transact(() => {
    for (const el of scene.elements) {
      elements.set(el.id, elementToYMap(el));
      order.push([el.id]);
    }
  });
  return doc;
}

/**
 * 把新场景的差异（视口 / 元素增删改）应用进 Y.Doc。须在调用方
 * `doc.transact(() => ..., origin)` 内调用 —— 以便统一 origin 给观察者。
 *
 * 修改元素的字段时尽量保留 Y.Text / Y.Map 实例（不替换 CRDT 内部结构）：
 *  - Y.Text 字段：若字符串值变了，delete-all + insert（不做 LCS 最小 diff,
 *    handler 驱动的更改本来就不是字符级输入流）
 *  - 嵌套 Y.Map 字段（style / label / endpoint）：遍历子字段，m.set 逐项覆盖
 *  - 其它槽：直接 m.set（含数组 / record / 标量）
 */
export function applySceneDiff(
  doc: Y.Doc,
  oldScene: BoardScene,
  newScene: BoardScene,
): void {
  const vp = doc.getMap<number>('viewport');
  if (oldScene.viewport.x !== newScene.viewport.x)
    vp.set('x', newScene.viewport.x);
  if (oldScene.viewport.y !== newScene.viewport.y)
    vp.set('y', newScene.viewport.y);
  if (oldScene.viewport.zoom !== newScene.viewport.zoom)
    vp.set('zoom', newScene.viewport.zoom);

  const elementsMap = doc.getMap<Y.Map<unknown>>('elements');
  const order = doc.getArray<string>('elementOrder');

  const oldIds = new Map<string, Element>();
  for (const el of oldScene.elements) oldIds.set(el.id, el);
  const newIds = new Map<string, Element>();
  for (const el of newScene.elements) newIds.set(el.id, el);

  for (const id of oldIds.keys()) {
    if (!newIds.has(id)) elementsMap.delete(id);
  }
  for (const newEl of newScene.elements) {
    const oldEl = oldIds.get(newEl.id);
    if (!oldEl) {
      elementsMap.set(newEl.id, elementToYMap(newEl));
      continue;
    }
    if (oldEl === newEl) continue;
    const m = elementsMap.get(newEl.id);
    if (!m) {
      elementsMap.set(newEl.id, elementToYMap(newEl));
      continue;
    }
    updateElementYMap(m, oldEl, newEl);
  }

  const newOrder = newScene.elements.map((e) => e.id);
  let needRebuildOrder = newOrder.length !== order.length;
  if (!needRebuildOrder) {
    for (let i = 0; i < newOrder.length; i += 1) {
      if (newOrder[i] !== order.get(i)) {
        needRebuildOrder = true;
        break;
      }
    }
  }
  if (needRebuildOrder) {
    order.delete(0, order.length);
    if (newOrder.length > 0) order.push(newOrder);
  }
}

/**
 * 元素级写操作集合 —— CLI/MCP 把「整场景写」降级为「相对基线的最小 op」，
 * server 端对**活 Y.Doc** 原子应用，从而并发各加各的永不互删（见
 * `diffScene` 注释）。
 */
export interface SceneOps {
  /** 基线里没有、目标里有 —— 新增的整元素。 */
  added: Element[];
  /** 两边都有但有字段变化 —— 只带变化的顶层字段（字段级 patch）。 */
  updated: Array<{ id: string; patch: Record<string, unknown> }>;
  /** 基线里有、目标里没有 —— 删除的元素 id。 */
  removed: string[];
}

/**
 * 算「基线场景 → 目标场景」的元素级差分（CLI 端用）。
 *
 * 关键：CLI 命令打开会话时 fetch 一份场景作 **基线**，在其上增删改后调 save。
 * 把 save 从「PUT 整场景替换」改成「diffScene(基线, 目标) → 发最小 op」，server
 * 再把这些 op 应用到**当时的活 Y.Doc**上。这样两个 Agent 并发各加各的元素时，
 * 谁的 op 都只描述「我动了什么」、不含「整场景应该长啥样」，故不会把对方刚加的
 * 元素当成「该删的」删掉 —— 这正是整场景 PUT 互删的根因（applySceneDiff 会把
 * 「活文档有、传入没有」的元素删掉）。
 *
 * `updated` 走字段级 patch（只带变化的顶层字段）：两 Agent 同改同一元素的不同
 * 字段时也尽量都保留。嵌套对象（style / label / start / end 等）整体比较、变了
 * 就整块带上。
 */
export function diffScene(base: BoardScene, next: BoardScene): SceneOps {
  const baseById = new Map(base.elements.map((e) => [e.id, e]));
  const nextById = new Map(next.elements.map((e) => [e.id, e]));

  const added: Element[] = [];
  const updated: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const removed: string[] = [];

  for (const id of baseById.keys()) {
    if (!nextById.has(id)) removed.push(id);
  }

  for (const el of next.elements) {
    const old = baseById.get(el.id);
    if (!old) {
      added.push(el);
      continue;
    }
    const patch: Record<string, unknown> = {};
    const cur = el as unknown as Record<string, unknown>;
    const prev = old as unknown as Record<string, unknown>;
    for (const k of Object.keys(cur)) {
      if (JSON.stringify(cur[k]) !== JSON.stringify(prev[k])) patch[k] = cur[k];
    }
    if (Object.keys(patch).length > 0) updated.push({ id: el.id, patch });
  }

  return { added, updated, removed };
}

/**
 * 把一组元素级 op 应用到一份场景上，返回新场景（server 端在 `room.mutate` 的
 * mutator 里对**活场景**调用本函数）。纯函数、不碰 Y.Doc —— 由调用方把返回值
 * 交给 applySceneDiff 落进 Y.Doc。
 */
export function applySceneOps(live: BoardScene, ops: SceneOps): BoardScene {
  const removedSet = new Set(ops.removed);
  const patchById = new Map(ops.updated.map((u) => [u.id, u.patch]));
  let elements = live.elements
    .filter((e) => !removedSet.has(e.id))
    .map((e) => {
      const patch = patchById.get(e.id);
      return patch ? ({ ...e, ...patch } as Element) : e;
    });
  const existing = new Set(elements.map((e) => e.id));
  for (const a of ops.added) {
    if (!existing.has(a.id)) elements.push(a);
  }
  return { ...live, elements };
}

function updateElementYMap(
  m: Y.Map<unknown>,
  oldEl: Element,
  newEl: Element,
): void {
  const newKeys = new Set(Object.keys(newEl));
  for (const k of Array.from(m.keys())) {
    if (!newKeys.has(k)) m.delete(k);
  }
  for (const [k, newVal] of Object.entries(newEl)) {
    const oldVal = (oldEl as unknown as Record<string, unknown>)[k];
    if (shallowEqual(oldVal, newVal) && m.has(k)) continue;
    const slot = m.get(k);
    if (slot instanceof Y.Text && typeof newVal === 'string') {
      if (slot.toString() !== newVal) {
        slot.delete(0, slot.length);
        if (newVal.length > 0) slot.insert(0, newVal);
      }
    } else if (
      slot instanceof Y.Map &&
      newVal &&
      typeof newVal === 'object' &&
      !Array.isArray(newVal)
    ) {
      if (k === 'payload' && newEl.type === 'suggestion') {
        const payload = newVal as Element;
        const oldPayload = (oldVal as Element | undefined) ?? payload;
        updateElementYMap(slot, oldPayload, payload);
        continue;
      }
      const newObj = newVal as Record<string, unknown>;
      const oldObj = (oldVal as Record<string, unknown> | undefined) ?? {};
      const isLabelMap =
        k === 'label' && (newEl.type === 'shape' || newEl.type === 'connector');
      for (const [sk, sv] of Object.entries(newObj)) {
        if (shallowEqual(oldObj[sk], sv) && slot.has(sk)) continue;
        if (isLabelMap && sk === 'text' && typeof sv === 'string') {
          let textSlot = slot.get('text');
          if (!(textSlot instanceof Y.Text)) {
            textSlot = new Y.Text();
            slot.set('text', textSlot);
          }
          const t = textSlot as Y.Text;
          if (t.toString() !== sv) {
            t.delete(0, t.length);
            if (sv.length > 0) t.insert(0, sv);
          }
        } else {
          slot.set(sk, sv);
        }
      }
      const newSubKeys = new Set(Object.keys(newObj));
      for (const sk of Array.from(slot.keys())) {
        if (!newSubKeys.has(sk)) slot.delete(sk);
      }
    } else {
      m.set(k, newVal);
    }
  }
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Y.Doc → BoardScene（每次读出最新投影）。
 * elements 数组顺序按 elementOrder 还原；order 里没有的 id 按 keys 顺序追加
 * 兜底（防 mutate 漏写 order）。
 */
export function yDocToScene(doc: Y.Doc): BoardScene {
  const vp = doc.getMap<number>('viewport');
  const elementsMap = doc.getMap<Y.Map<unknown>>('elements');
  const order = doc.getArray<string>('elementOrder');
  const elements: Element[] = [];
  const seen = new Set<string>();
  for (const id of order.toArray()) {
    const m = elementsMap.get(id);
    if (m && !seen.has(id)) {
      elements.push(yMapToElement(m));
      seen.add(id);
    }
  }
  for (const id of Array.from(elementsMap.keys())) {
    if (!seen.has(id)) {
      const m = elementsMap.get(id);
      if (m) elements.push(yMapToElement(m));
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    viewport: {
      x: Number(vp.get('x') ?? 0),
      y: Number(vp.get('y') ?? 0),
      zoom: Number(vp.get('zoom') ?? 1),
    },
    elements,
  };
}
