/**
 * Web 端 Yjs 客户端（M4 增量3）—— 经 WebSocket /yjs 与 server 的 Y.Doc
 * 实时同步。每端持本地 Y.Doc 副本，由 Yjs 协议自动收敛到一致状态：
 *  - 字段级 CRDT：两人同时改同一元素的不同字段都保留
 *  - 字符级 CRDT：两人同时在同一 Y.Text 里打字按字符合并
 *
 * 与 server/yjs-room.ts 对称：握手期发 sync step1 + 接收 awareness 全量；
 * 后续以 sync update / awareness update 帧增量同步。
 *
 * 自动重连：网络抖动 / server 重启时按指数退避（1s, 2s, 4s, 上限 30s）
 * 自动重新建立 ws，并自动重新发起 sync 握手补齐缺失的更新。
 */
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/** 客户端连接状态。 */
export type YjsClientStatus = 'connecting' | 'connected' | 'offline';

export interface YjsClient {
  /** 本地 Y.Doc 副本（与 server Y.Doc 自动同步）。 */
  readonly doc: Y.Doc;
  /** Awareness 实例（presence / 光标用，预留）。 */
  readonly awareness: awarenessProtocol.Awareness;
  /** 当前连接状态。 */
  getStatus(): YjsClientStatus;
  /** 订阅状态变化；返回取消函数。 */
  subscribeStatus(handler: (s: YjsClientStatus) => void): () => void;
  /** 主动断开（用于卸载或切换白板）。断开后不会自动重连。 */
  disconnect(): void;
}

export interface CreateYjsClientOptions {
  /** ws URL，如 `ws://127.0.0.1:4500/yjs/<boardId>`。 */
  url: string;
}

export function createYjsClient(opts: CreateYjsClientOptions): YjsClient {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);

  let ws: WebSocket | null = null;
  let status: YjsClientStatus = 'connecting';
  let stopped = false;
  let reconnectAttempt = 0;
  let reconnectTimer: number | null = null;
  const statusHandlers = new Set<(s: YjsClientStatus) => void>();

  function setStatus(next: YjsClientStatus): void {
    if (next === status) return;
    status = next;
    for (const h of statusHandlers) {
      try {
        h(next);
      } catch (err) {
        console.error('[yjs-client] status handler 抛错:', err);
      }
    }
  }

  // 本地 Y.Doc 更新 → 经 ws 发给 server。origin === ws 是 server 端来的更新，
  // 不能再回发（避免回环）。
  function onDocUpdate(update: Uint8Array, origin: unknown): void {
    if (origin === ws) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MESSAGE_SYNC);
    syncProtocol.writeUpdate(e, update);
    ws.send(encoding.toUint8Array(e));
  }
  doc.on('update', onDocUpdate);

  function onAwarenessUpdate(
    info: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void {
    if (origin === ws) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const changed = info.added.concat(info.updated, info.removed);
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      e,
      awarenessProtocol.encodeAwarenessUpdate(awareness, changed),
    );
    ws.send(encoding.toUint8Array(e));
  }
  awareness.on('update', onAwarenessUpdate);

  function connect(): void {
    if (stopped) return;
    setStatus('connecting');
    const sock = new WebSocket(opts.url);
    sock.binaryType = 'arraybuffer';
    ws = sock;

    sock.onopen = () => {
      reconnectAttempt = 0;
      setStatus('connected');
      // 主动发 sync step1 与 server 互同步（带本地状态向量请求 server 补齐）
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(e, doc);
      sock.send(encoding.toUint8Array(e));
      // 重连后立刻把本地 awareness 全量补发给 server，避免 server 端漏掉
      const localState = awareness.getLocalState();
      if (localState) {
        const ae = encoding.createEncoder();
        encoding.writeVarUint(ae, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          ae,
          awarenessProtocol.encodeAwarenessUpdate(awareness, [
            awareness.clientID,
          ]),
        );
        sock.send(encoding.toUint8Array(ae));
      }
    };

    sock.onmessage = (ev: MessageEvent) => {
      try {
        const raw = ev.data as ArrayBuffer | ArrayBufferView | Uint8Array;
        const u8 =
          raw instanceof ArrayBuffer
            ? new Uint8Array(raw)
            : raw instanceof Uint8Array
              ? raw
              : new Uint8Array(raw.buffer);
        const dec = decoding.createDecoder(u8);
        const enc = encoding.createEncoder();
        const type = decoding.readVarUint(dec);
        if (type === MESSAGE_SYNC) {
          encoding.writeVarUint(enc, MESSAGE_SYNC);
          // origin=ws 标记这次更新来自 server，防止 onDocUpdate 回发
          syncProtocol.readSyncMessage(dec, enc, doc, sock);
          if (encoding.length(enc) > 1) sock.send(encoding.toUint8Array(enc));
        } else if (type === MESSAGE_AWARENESS) {
          awarenessProtocol.applyAwarenessUpdate(
            awareness,
            decoding.readVarUint8Array(dec),
            sock,
          );
        }
      } catch (err) {
        console.error('[yjs-client] 处理 ws 消息失败:', err);
      }
    };

    sock.onclose = () => {
      ws = null;
      if (stopped) {
        setStatus('offline');
        return;
      }
      setStatus('offline');
      scheduleReconnect();
    };

    sock.onerror = () => {
      // close 会跟上来，由 close 触发重连
    };
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    if (reconnectTimer !== null) return;
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** reconnectAttempt,
    );
    reconnectAttempt += 1;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  connect();

  return {
    doc,
    awareness,
    getStatus: () => status,
    subscribeStatus: (h) => {
      statusHandlers.add(h);
      return () => statusHandlers.delete(h);
    },
    disconnect: () => {
      stopped = true;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      doc.off('update', onDocUpdate);
      awareness.off('update', onAwarenessUpdate);
      if (ws) {
        try {
          ws.close();
        } catch {
          // ignore
        }
        ws = null;
      }
      awareness.destroy();
      doc.destroy();
    },
  };
}
