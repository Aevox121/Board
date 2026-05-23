/**
 * board-server 事件流客户端 —— 通过 SSE 订阅白板变化。
 *
 * server 在 `GET /api/events` 以 Server-Sent Events 推送事件，dev 经 Vite proxy
 * 转发（见 vite.config.ts）。本模块只用浏览器内置 `EventSource`，不引入依赖。
 *
 * 同一通道承载多类帧（M2/M4）：
 *  - `{"type":"board-changed"}` —— 粗粒度变更信号 → 整板重新拉取；
 *  - `{"type":"ops",...}` —— 操作级增量 → 增量更新；
 *  - `{"type":"presence" | "presence-leave",...}` —— 在场光标更新 / 离开；
 *  - 结构化事件流事件（带 `seq`）—— 供 `board watch`，Web 端不关心。
 *
 * 本模块只做「连接 + 解析 + 分发」：把每个解析成功的帧交给 `onFrame`，
 * 由调用方（App 层）按 `type` 路由。
 *
 * 设计原则（server 不可达时不报错）：
 *  - server 未启动 / 端点未实现 → `EventSource` 触发 `error`，静默忽略，
 *    不向上抛错、不打断离线模式（EventSource 自带重连）。
 *  - 解析失败的消息直接丢弃，不影响后续事件。
 */

import { apiUrl } from './boardSession';

/** server 推送的事件帧 —— 字段随 type 而定，调用方据 type 取用。 */
export interface SseFrame {
  type: string;
  [key: string]: unknown;
}

/**
 * 订阅 board-server 的事件流。
 *
 * @param onFrame 每收到一个解析成功的帧即调用，由调用方按 type 路由。
 * @returns 取消订阅函数 —— 组件卸载时调用以关闭连接。
 */
export function subscribeBoardEvents(onFrame: (frame: SseFrame) => void): () => void {
  let source: EventSource | null = null;

  try {
    source = new EventSource(apiUrl('/events'));
  } catch {
    // 极少数浏览器/环境构造 EventSource 即抛错 —— 视为离线，返回空清理函数。
    return () => {};
  }

  const es = source;

  es.addEventListener('message', (ev: MessageEvent<string>) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(ev.data);
    } catch {
      // 非 JSON 或格式异常的消息直接忽略，不影响后续事件。
      return;
    }
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { type?: unknown }).type === 'string'
    ) {
      onFrame(parsed as SseFrame);
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
