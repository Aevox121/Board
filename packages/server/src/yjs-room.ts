/**
 * Yjs 房间（PRD §7 M4 实时同步工作包）—— Server 端的权威 Y.Doc。
 *
 * 启动期：读 board.json → sceneToYDoc 构 Y.Doc，之后 Y.Doc 即运行态权威源。
 * 持久化：观察 Y.Doc 更新，节流 投影回 board.json（保持人可读 .board
 * 文件夹承诺，board.json 既是落盘备份也是导出可读副本）。
 * 网络：y-protocols sync v2 + awareness over WebSocket；新连接接入即互
 * 同步状态、之后增量广播。
 *
 * 房间生命周期与 board-server 进程一致 —— 单板单房间。
 */
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type { WebSocket } from 'ws';
import {
  sceneToYDoc,
  yDocToScene,
  elementToYMap,
  type BoardScene,
  type Element,
} from '@board/core';

/** y-protocols 报文类型。 */
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

/** 节流落盘窗口（毫秒）——多次连续 mutate 合并为一次写盘。 */
const SAVE_DEBOUNCE_MS = 300;

/** 房间状态。 */
export interface YjsRoom {
  /** 底层 Y.Doc —— 高级用法可直接 mutate（须包在 doc.transact 里附 origin）。 */
  readonly doc: Y.Doc;
  /** Awareness 实例 —— presence / 光标等可经此广播（本增量未启用）。 */
  readonly awareness: awarenessProtocol.Awareness;
  /** 当前场景的快照（从 Y.Doc 实时投影）。 */
  getScene(): BoardScene;
  /**
   * 场景级突变 —— 取代 loadBoard + 改 + saveBoard 模式：
   *   1. 读出当前场景（从 Y.Doc）
   *   2. 调 mutator(scene) → newScene
   *   3. diff 出元素级变化，在一次 transaction 里 apply 进 Y.Doc（带 origin = actor）
   *   4. Y.Doc 自动节流投影回 board.json + 广播给所有 ws
   *
   * mutator 返回 null 表示「无变化」，跳过事务。
   */
  mutate(actor: string, mutator: (scene: BoardScene) => BoardScene | null): void;
  /** 接管一条 ws 连接（HTTP server 的 upgrade 事件转入）。 */
  handleWsConnection(ws: WebSocket): void;
  /** 强制立即把当前 Y.Doc 投影到 board.json（关停时用）。 */
  flushToDisk(): Promise<void>;
  /** 关停房间：清理 observers / 关 awareness。 */
  close(): void;
}

/** 创建房间（启动时调用一次）。 */
export interface CreateYjsRoomOptions {
  /** .board 目录绝对路径（用于落盘到 board.json）。 */
  dir: string;
  /** 启动初始场景（loadBoard 的结果）。 */
  initialScene: BoardScene;
  /**
   * 投影回 board.json 的回调 —— server/index.ts 注入完整的 saveBoard
   * (需要 meta 参数)，让本模块对 meta 持有零知识。
   */
  saveScene: (scene: BoardScene) => Promise<void>;
}

export function createYjsRoom(opts: CreateYjsRoomOptions): YjsRoom {
  const { initialScene, saveScene, dir } = opts;
  const doc = sceneToYDoc(initialScene);
  const awareness = new awarenessProtocol.Awareness(doc);

  // 注册所有活跃 ws 连接 —— Y.Doc 变化时向它们转发增量 update。
  const conns = new Set<WebSocket>();

  // ── 节流落盘 ────────────────────────────────────────────────
  let saveTimer: NodeJS.Timeout | null = null;
  let pendingSave = false;
  let savingNow = false;
  function scheduleSave(): void {
    pendingSave = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void doSave();
    }, SAVE_DEBOUNCE_MS);
  }
  async function doSave(): Promise<void> {
    if (savingNow) return; // 与下一次 scheduleSave 串行
    savingNow = true;
    pendingSave = false;
    try {
      const scene = yDocToScene(doc);
      await saveScene(scene);
    } catch (err) {
      console.error('[yjs-room] 投影 board.json 失败:', err);
    } finally {
      savingNow = false;
      if (pendingSave) scheduleSave(); // 落盘期间又来了变更
    }
  }

  // ── Y.Doc 更新：转发给所有 ws + 触发节流落盘 ──────────────────
  function onDocUpdate(update: Uint8Array, origin: unknown): void {
    // 广播给除发起方以外的所有 ws
    const msg = encodeSyncUpdate(update);
    for (const ws of conns) {
      if (origin === ws) continue; // 不回声给发起方
      try {
        ws.send(msg);
      } catch {
        // ws 已断开，cleanup 在 close 事件里
      }
    }
    scheduleSave();
  }
  doc.on('update', onDocUpdate);

  // ── Awareness：广播给所有 ws ──────────────────────────────────
  function onAwarenessUpdate(
    info: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void {
    const changed = info.added.concat(info.updated, info.removed);
    const msg = encodeAwarenessUpdate(awareness, changed);
    for (const ws of conns) {
      if (origin === ws) continue;
      try {
        ws.send(msg);
      } catch {
        // 同上
      }
    }
  }
  awareness.on('update', onAwarenessUpdate);

  // ── mutate：diff 新旧场景 → 应用最小 op 集合进 Y.Doc ─────────
  function mutate(
    actor: string,
    mutator: (scene: BoardScene) => BoardScene | null,
  ): void {
    const oldScene = yDocToScene(doc);
    const next = mutator(oldScene);
    if (next === null) return;
    doc.transact(() => {
      applySceneDiff(doc, oldScene, next);
    }, actor);
  }

  function handleWsConnection(ws: WebSocket): void {
    ws.binaryType = 'arraybuffer';
    conns.add(ws);

    // 初始 sync step1（带状态向量），让对端把缺失的更新发回来
    const e1 = encoding.createEncoder();
    encoding.writeVarUint(e1, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(e1, doc);
    try {
      ws.send(encoding.toUint8Array(e1));
    } catch {
      conns.delete(ws);
      return;
    }
    // 发当前 awareness 全量
    const awStates = awareness.getStates();
    if (awStates.size > 0) {
      const e2 = encoding.createEncoder();
      encoding.writeVarUint(e2, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        e2,
        awarenessProtocol.encodeAwarenessUpdate(
          awareness,
          Array.from(awStates.keys()),
        ),
      );
      try {
        ws.send(encoding.toUint8Array(e2));
      } catch {
        // 忽略，close 事件会清理
      }
    }

    ws.on('message', (data) => {
      try {
        const buf =
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : Array.isArray(data)
              ? Buffer.concat(data as Buffer[])
              : (data as Buffer);
        const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
        const dec = decoding.createDecoder(u8);
        const enc = encoding.createEncoder();
        const messageType = decoding.readVarUint(dec);
        if (messageType === MESSAGE_SYNC) {
          encoding.writeVarUint(enc, MESSAGE_SYNC);
          syncProtocol.readSyncMessage(dec, enc, doc, ws);
          if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
        } else if (messageType === MESSAGE_AWARENESS) {
          awarenessProtocol.applyAwarenessUpdate(
            awareness,
            decoding.readVarUint8Array(dec),
            ws,
          );
        }
      } catch (err) {
        console.error('[yjs-room] 处理 ws 消息失败:', err);
      }
    });

    const cleanup = (): void => {
      conns.delete(ws);
      // 移除该客户端的 awareness 条目
      const aw = awareness as awarenessProtocol.Awareness & { clientID: number };
      awarenessProtocol.removeAwarenessStates(
        awareness,
        Array.from(awareness.getStates().keys()).filter((id) => id !== aw.clientID),
        ws,
      );
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  }

  async function flushToDisk(): Promise<void> {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    await doSave();
  }

  function close(): void {
    if (saveTimer) clearTimeout(saveTimer);
    doc.off('update', onDocUpdate);
    awareness.off('update', onAwarenessUpdate);
    awareness.destroy();
    for (const ws of conns) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    conns.clear();
    doc.destroy();
  }

  // 引用 dir 防止 TS 报未用警告（保留接口完整性，便于将来扩展 .runtime 写入）
  void dir;
  void resolve;
  void writeFile;

  return {
    doc,
    awareness,
    getScene: () => yDocToScene(doc),
    mutate,
    handleWsConnection,
    flushToDisk,
    close,
  };
}

// ───────────────────────── helpers ─────────────────────────

function encodeSyncUpdate(update: Uint8Array): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, MESSAGE_SYNC);
  syncProtocol.writeUpdate(e, update);
  return encoding.toUint8Array(e);
}

function encodeAwarenessUpdate(
  awareness: awarenessProtocol.Awareness,
  changed: number[],
): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(
    e,
    awarenessProtocol.encodeAwarenessUpdate(awareness, changed),
  );
  return encoding.toUint8Array(e);
}

/**
 * 把新场景的差异（视口 / 元素增删改）应用进 Y.Doc 的 elements / viewport /
 * elementOrder。需要在调用方 doc.transact 内调用（带 origin）。
 *
 * 修改元素的字段时按以下策略尽量保留 Y.Text / Y.Map 实例（不替换 CRDT 内部
 * 结构）：
 *  - Y.Text 字段：若字符串值变了，delete-all + insert（不做最小 diff，
 *    handler 驱动的更改本来就不是字符级输入流）
 *  - Y.Map 字段（style / label / endpoint）：遍历子字段，m.set 逐项覆盖
 *  - 其它槽：直接 m.set（含数组 / record / 标量）
 */
function applySceneDiff(
  doc: Y.Doc,
  oldScene: BoardScene,
  newScene: BoardScene,
): void {
  // viewport
  const vp = doc.getMap<number>('viewport');
  if (oldScene.viewport.x !== newScene.viewport.x) vp.set('x', newScene.viewport.x);
  if (oldScene.viewport.y !== newScene.viewport.y) vp.set('y', newScene.viewport.y);
  if (oldScene.viewport.zoom !== newScene.viewport.zoom)
    vp.set('zoom', newScene.viewport.zoom);

  const elementsMap = doc.getMap<Y.Map<unknown>>('elements');
  const order = doc.getArray<string>('elementOrder');

  const oldIds = new Map<string, Element>();
  for (const el of oldScene.elements) oldIds.set(el.id, el);
  const newIds = new Map<string, Element>();
  for (const el of newScene.elements) newIds.set(el.id, el);

  // 删除：旧有、新无
  for (const id of oldIds.keys()) {
    if (!newIds.has(id)) elementsMap.delete(id);
  }
  // 新增 / 改：遍历新场景
  for (const newEl of newScene.elements) {
    const oldEl = oldIds.get(newEl.id);
    if (!oldEl) {
      elementsMap.set(newEl.id, elementToYMap(newEl));
      continue;
    }
    if (oldEl === newEl) continue; // 引用相同直接跳
    const m = elementsMap.get(newEl.id);
    if (!m) {
      elementsMap.set(newEl.id, elementToYMap(newEl));
      continue;
    }
    updateElementYMap(m, oldEl, newEl);
  }

  // elementOrder：按新场景顺序整体替换（简单粗暴；元素增删少时浪费不多）
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

function updateElementYMap(
  m: Y.Map<unknown>,
  oldEl: Element,
  newEl: Element,
): void {
  const newKeys = new Set(Object.keys(newEl));
  // 移除已不存在的字段
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
    } else if (slot instanceof Y.Map && newVal && typeof newVal === 'object' && !Array.isArray(newVal)) {
      // 子 Y.Map（style / label / endpoint / payload 等）—— 递归字段级更新
      if (k === 'payload' && newEl.type === 'suggestion') {
        // suggestion.payload 是 Element，特殊
        const payload = newVal as Element;
        const oldPayload = (oldVal as Element | undefined) ?? payload;
        updateElementYMap(slot, oldPayload, payload);
        continue;
      }
      const newObj = newVal as Record<string, unknown>;
      const oldObj = (oldVal as Record<string, unknown> | undefined) ?? {};
      // shape/connector label 子层有 text:Y.Text
      const isLabelMap = k === 'label' && (newEl.type === 'shape' || newEl.type === 'connector');
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
      // 删去子层多余键
      const newSubKeys = new Set(Object.keys(newObj));
      for (const sk of Array.from(slot.keys())) {
        if (!newSubKeys.has(sk)) slot.delete(sk);
      }
    } else {
      // 其它槽（含数组 / record / null / 标量）—— 直接覆盖
      m.set(k, newVal);
    }
  }
}

/** 浅相等：标量直比；数组 / record JSON 字符串比对（够用，handler 驱动场景）。 */
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
