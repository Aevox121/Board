/**
 * board-server 事件流客户端 —— 通过 SSE 订阅白板变化（M2 实时刷新）。
 *
 * server 在 `GET /api/events` 以 Server-Sent Events 推送事件，dev 经 Vite proxy
 * 转发（见 vite.config.ts）。本模块只用浏览器内置 `EventSource`，不引入依赖。
 *
 * 设计原则（对应任务「server 不可达时不报错」）：
 *  - server 未启动 / 端点未实现 → `EventSource` 触发 `error`，本模块静默忽略，
 *    不向上抛错、不打断离线模式。
 *  - 收到 `{"type":"board-changed"}` 事件 → 回调通知上层重新拉取白板。
 *  - 解析失败的消息直接丢弃，不影响后续事件。
 */

/** API 基址 —— 与 server/client.ts 一致，走相对路径由 Vite proxy 转发。 */
const API_BASE = '/api';

/** server 推送的事件信封 —— M2 只关心 `board-changed`。 */
interface BoardEvent {
  type: string;
}

/**
 * 订阅 board-server 的事件流。
 *
 * @param onBoardChanged 收到 `board-changed` 事件时触发（上层据此重新 fetchBoard）
 * @returns 取消订阅函数 —— 组件卸载时调用以关闭连接。
 */
export function subscribeBoardEvents(onBoardChanged: () => void): () => void {
  let source: EventSource | null = null;

  try {
    source = new EventSource(`${API_BASE}/events`);
  } catch {
    // 极少数浏览器/环境构造 EventSource 即抛错 —— 视为离线，返回空清理函数。
    return () => {};
  }

  const es = source;

  es.addEventListener('message', (ev: MessageEvent<string>) => {
    let parsed: BoardEvent;
    try {
      parsed = JSON.parse(ev.data) as BoardEvent;
    } catch {
      // 非 JSON 或格式异常的消息直接忽略，不影响后续事件。
      return;
    }
    if (parsed.type === 'board-changed') {
      onBoardChanged();
    }
  });

  es.addEventListener('error', () => {
    // server 未启动 / 端点未实现 / 连接中断 —— 静默处理，保持离线模式可用。
    // EventSource 自带重连机制，server 恢复后会自动重新建立连接。
  });

  return () => {
    es.close();
  };
}
