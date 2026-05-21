/**
 * 事件流 —— 白板变化的结构化事件（specs/CLI与MCP规格.md §5）。
 *
 * 服务以 SSE / NDJSON 推送这些事件，供 `board watch` 与 MCP
 * `board_subscribe_events` 订阅。Agent 据事件做 Board Context 增量更新，
 * 不必反复全量 `board_read_context`。
 *
 * 本模块提供：
 *  - 事件类型定义（`BoardEvent` / `BoardEventType`）；
 *  - `diffScenes` —— 比对前后两个场景，产出 element / file / region /
 *    suggestion 类「变化事件」。seq / ts 由服务端事件日志补全。
 *
 * 生命周期类语义事件（`suggestion.accepted` 等三态、`agent.task.*`、
 * `participant.*`、`snapshot.*`）无法由场景 diff 推断，由各自的处理器直接发出。
 */
import type {
  BoardScene,
  Element,
  FileElement,
  ISO8601,
  ParticipantId,
  RegionElement,
} from './types.js';

/** 事件流的全部事件类型（specs/CLI与MCP规格.md §5）。 */
export type BoardEventType =
  | 'element.created'
  | 'element.updated'
  | 'element.moved'
  | 'element.deleted'
  | 'file.added'
  | 'file.moved'
  | 'file.deleted'
  | 'region.created'
  | 'region.described'
  | 'suggestion.created'
  | 'suggestion.accepted'
  | 'suggestion.rejected'
  | 'suggestion.commented'
  | 'agent.task.started'
  | 'agent.task.progress'
  | 'agent.task.finished'
  | 'participant.joined'
  | 'participant.left'
  | 'participant.cursor'
  | 'snapshot.created'
  | 'snapshot.restored';

/** 推送给订阅方的一条事件。 */
export interface BoardEvent {
  /** 单调递增序号 —— 订阅方据此做增量游标（cursor）。 */
  seq: number;
  type: BoardEventType;
  /** 触发者参与者 id（人 `u_` / Agent `a_` / 系统 `u_system`）。 */
  actor: ParticipantId;
  ts: ISO8601;
  /** 事件细节；至少含 `elementId` / `region`（无区域为 null）。 */
  payload: Record<string, unknown>;
}

/** 未编号的事件草稿 —— seq / ts 由服务端事件日志补全。 */
export type DraftEvent = Pick<BoardEvent, 'type' | 'actor' | 'payload'>;

/** 比对时忽略的字段 —— 每次写入都会变，不代表「内容」变化。 */
const VOLATILE_KEYS = new Set(['updatedAt', 'updatedBy']);

/** 仅涉及几何/归属的字段 —— 全部变更落在此集合内 → 视为「移动」而非「更新」。 */
const GEOM_KEYS = new Set([
  'x',
  'y',
  'width',
  'height',
  'z',
  'angle',
  'parentId',
  'autoPlaced',
]);

/**
 * 元素「内容签名」—— 去掉易变时间戳（updatedAt / updatedBy）后做 JSON 比对。
 * 用于快速判等：签名相同即视为元素内容未变（不含纯触碰）。
 */
export function elementSignature(el: Element): string {
  return JSON.stringify(el, (k, v) => (VOLATILE_KEYS.has(k) ? undefined : v));
}

/** 列出两个元素之间发生变化的顶层字段（忽略易变时间戳）。 */
function changedKeys(a: Element, b: Element): string[] {
  const ar = a as unknown as Record<string, unknown>;
  const br = b as unknown as Record<string, unknown>;
  const keys = new Set<string>([...Object.keys(ar), ...Object.keys(br)]);
  const out: string[] = [];
  for (const k of keys) {
    if (VOLATILE_KEYS.has(k)) continue;
    if (JSON.stringify(ar[k]) !== JSON.stringify(br[k])) out.push(k);
  }
  return out;
}

/** 建「区域 id → 区域名」索引，用于把元素归到所属区域。 */
function regionLabels(scene: BoardScene): Map<string, string> {
  const m = new Map<string, string>();
  for (const el of scene.elements) {
    if (el.type === 'region') m.set(el.id, (el as RegionElement).label);
  }
  return m;
}

/** 元素所属区域名 —— parentId 指向 region 时返回其名，否则 null。 */
function regionOf(el: Element, regions: Map<string, string>): string | null {
  return el.parentId ? (regions.get(el.parentId) ?? null) : null;
}

/** 事件 payload 基础字段 —— 订阅方据 elementId 再 `board_get_element` 取详情。 */
function basePayload(el: Element, region: string | null): Record<string, unknown> {
  const p: Record<string, unknown> = {
    elementId: el.id,
    elementType: el.type,
    region,
  };
  if (el.type === 'file') p['path'] = (el as FileElement).path;
  if (el.type === 'region') p['label'] = (el as RegionElement).label;
  return p;
}

/**
 * 比对前后两个场景，产出变化事件（无 seq / ts —— 由事件日志补全）。
 *
 * - 新增元素 → `file.added` / `region.created` / `suggestion.created` /
 *   `element.created`（按类型）。
 * - 删除元素 → `file.deleted` / `element.deleted`。
 * - 改动元素 → 区域改名/描述 = `region.described`；仅几何字段变 = `*.moved`；
 *   其余 = `element.updated`。
 *
 * 每条事件的 `actor` 优先取元素自身的 `createdBy` / `updatedBy`，
 * 取不到时回退到 `fallbackActor`。
 */
export function diffScenes(
  prev: BoardScene,
  next: BoardScene,
  fallbackActor: ParticipantId,
): DraftEvent[] {
  const events: DraftEvent[] = [];
  const prevMap = new Map(prev.elements.map((e) => [e.id, e]));
  const nextMap = new Map(next.elements.map((e) => [e.id, e]));
  const prevRegions = regionLabels(prev);
  const nextRegions = regionLabels(next);

  // 新增
  for (const el of next.elements) {
    if (prevMap.has(el.id)) continue;
    let type: BoardEventType = 'element.created';
    if (el.type === 'file') type = 'file.added';
    else if (el.type === 'region') type = 'region.created';
    else if (el.type === 'suggestion') type = 'suggestion.created';
    events.push({
      type,
      actor: el.createdBy || fallbackActor,
      payload: basePayload(el, regionOf(el, nextRegions)),
    });
  }

  // 删除
  for (const el of prev.elements) {
    if (nextMap.has(el.id)) continue;
    events.push({
      type: el.type === 'file' ? 'file.deleted' : 'element.deleted',
      actor: el.updatedBy || fallbackActor,
      payload: basePayload(el, regionOf(el, prevRegions)),
    });
  }

  // 改动
  for (const el of next.elements) {
    const before = prevMap.get(el.id);
    if (!before) continue;
    if (elementSignature(before) === elementSignature(el)) continue;
    const keys = changedKeys(before, el);
    let type: BoardEventType;
    if (
      el.type === 'region' &&
      keys.some((k) => k === 'label' || k === 'description')
    ) {
      type = 'region.described';
    } else {
      // 文件移动同时改 path（改归属）—— 一并算入「移动」字段集。
      const moveKeys = el.type === 'file' ? new Set([...GEOM_KEYS, 'path']) : GEOM_KEYS;
      const geomOnly = keys.length > 0 && keys.every((k) => moveKeys.has(k));
      if (geomOnly) type = el.type === 'file' ? 'file.moved' : 'element.moved';
      else type = 'element.updated';
    }
    events.push({
      type,
      actor: el.updatedBy || fallbackActor,
      payload: { ...basePayload(el, regionOf(el, nextRegions)), changed: keys },
    });
  }

  return events;
}
