/**
 * board-server 事件流客户端 —— 通过 SSE 订阅白板变化。
 *
 * server 在 `GET /api/events` 以 Server-Sent Events 推送事件，dev 经 Vite proxy
 * 转发（见 vite.config.ts）。本模块只用浏览器内置 `EventSource`，不引入依赖。
 *
 * 同一通道承载三类帧（M4）：
 *  - `{"type":"board-changed"}` —— 粗粒度变更信号 → 上层整板重新拉取；
 *  - `{"type":"ops","ops":[...],"origin":"<id>"}` —— 操作级增量 → 上层据此
 *    增量更新（`origin` 让发起端忽略自己的回声）；
 *  - 结构化事件流事件（带 `seq`）—— 供 `board watch`，Web 端不关心、忽略。
 *
 * 设计原则（server 不可达时不报错）：
 *  - server 未启动 / 端点未实现 → `EventSource` 触发 `error`，静默忽略，
 *    不向上抛错、不打断离线模式（EventSource 自带重连）。
 *  - 解析失败的消息直接丢弃，不影响后续事件。
 */

/** API 基址 —— 与 server/client.ts 一致，走相对路径由 Vite proxy 转发。 */
const API_BASE = '/api';

/** server 推送的事件信封。 */
interface SseFrame {
  type: string;
  ops?: unknown;
  origin?: unknown;
}

/** 订阅回调集合。 */
export interface BoardEventHandlers {
  /** 收到 `board-changed` —— 上层据此整板重新拉取。 */
  onBoardChanged: () => void;
  /** 收到 `ops` 帧 —— 上层据此把增量操作应用到本地场景。 */
  onOps: (frame: { ops: unknown; origin: string }) => void;
}

/**
 * 订阅 board-server 的事件流。
 *
 * @param handlers board-changed / ops 两类帧的回调。
 * @returns 取消订阅函数 —— 组件卸载时调用以关闭连接。
 */
export function subscribeBoardEvents(handlers: BoardEventHandlers): () => void {
  let source: EventSource | null = null;

  try {
    source = new EventSource(`${API_BASE}/events`);
  } catch {
    // 极少数浏览器/环境构造 EventSource 即抛错 —— 视为离线，返回空清理函数。
    return () => {};
  }

  const es = source;

  es.addEventListener('message', (ev: MessageEvent<string>) => {
    let parsed: SseFrame;
    try {
      parsed = JSON.parse(ev.data) as SseFrame;
    } catch {
      // 非 JSON 或格式异常的消息直接忽略，不影响后续事件。
      return;
    }
    if (parsed.type === 'board-changed') {
      handlers.onBoardChanged();
    } else if (parsed.type === 'ops' && Array.isArray(parsed.ops)) {
      handlers.onOps({
        ops: parsed.ops,
        origin: typeof parsed.origin === 'string' ? parsed.origin : '',
      });
    }
    // 其余（带 seq 的事件流事件）Web 端不关心。
  });

  es.addEventListener('error', () => {
    // server 未启动 / 端点未实现 / 连接中断 —— 静默处理，保持离线模式可用。
    // EventSource 自带重连机制，server 恢复后会自动重新建立连接。
  });

  return () => {
    es.close();
  };
}
