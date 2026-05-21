/**
 * 操作级同步 —— 把场景变化表达为元素级「操作」（upsert / delete），
 * 而非整场景覆盖（M4 增量2：实时同步）。
 *
 * 整场景 PUT 在多端并发写时会「后写覆盖前写」：一个客户端持有的旧场景，
 * 落盘时会把别处的并发改动一并抹掉。改为各端只发「自己改了哪些元素」的
 * 增量操作、由服务端按元素 id 合并 —— 一端动 A、另一端动 B，互不覆盖。
 *
 * viewport 是各端各自的视野，不属于「内容」，不进操作流。
 */
import type { BoardScene, Element, ElementId } from './types.js';
import { elementSignature } from './events.js';

/** 元素级操作。 */
export type BoardOp =
  | { kind: 'upsert'; element: Element }
  | { kind: 'delete'; id: ElementId };

/**
 * 比对前后场景，产出把 `prev` 变成 `next` 所需的最小操作集。
 * 新增 / 内容变化的元素 → upsert；消失的元素 → delete；viewport 忽略。
 */
export function diffToOps(prev: BoardScene, next: BoardScene): BoardOp[] {
  const ops: BoardOp[] = [];
  const prevMap = new Map(prev.elements.map((e) => [e.id, e]));
  const nextMap = new Map(next.elements.map((e) => [e.id, e]));
  for (const el of next.elements) {
    const before = prevMap.get(el.id);
    if (!before || elementSignature(before) !== elementSignature(el)) {
      ops.push({ kind: 'upsert', element: el });
    }
  }
  for (const el of prev.elements) {
    if (!nextMap.has(el.id)) ops.push({ kind: 'delete', id: el.id });
  }
  return ops;
}

/**
 * 把一组操作应用到场景，返回新场景（按元素 id 合并）。
 * upsert 覆盖同 id 元素 / 不存在则追加；delete 按 id 移除。
 */
export function applyOps(scene: BoardScene, ops: BoardOp[]): BoardScene {
  if (ops.length === 0) return scene;
  const byId = new Map(scene.elements.map((e) => [e.id, e]));
  for (const op of ops) {
    if (op.kind === 'upsert') byId.set(op.element.id, op.element);
    else byId.delete(op.id);
  }
  return { ...scene, elements: [...byId.values()] };
}

/** 轻量校验一个值是否像 BoardOp（服务端入参校验用）。 */
export function isBoardOp(v: unknown): v is BoardOp {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o['kind'] === 'upsert') {
    const el = o['element'];
    return (
      typeof el === 'object' &&
      el !== null &&
      typeof (el as Record<string, unknown>)['id'] === 'string' &&
      typeof (el as Record<string, unknown>)['type'] === 'string'
    );
  }
  if (o['kind'] === 'delete') return typeof o['id'] === 'string';
  return false;
}
