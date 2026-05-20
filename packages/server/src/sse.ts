/**
 * SSE 广播 — `GET /api/events` 的连接管理与事件推送。
 *
 * 用 Node 内置 `node:http` 原生实现 Server-Sent Events：
 *  - 每个客户端 = 一个 ServerResponse，保持长连接
 *  - reconcile 使白板变化时，向所有连接推送一行 `data: {...}\n\n`
 *  - 客户端断开（close/error）时从集合移除，避免向死连接写入
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** 推给客户端的事件载荷。 */
export interface SseEvent {
  /** 事件类型，目前仅 `board-changed` */
  type: string;
}

/** SSE 广播器对外句柄。 */
export interface SseHub {
  /** 接管一个请求，升级为 SSE 长连接并加入广播集合。 */
  handle(req: IncomingMessage, res: ServerResponse): void;
  /** 向所有在线连接广播一个事件。 */
  broadcast(event: SseEvent): void;
  /** 当前连接数。 */
  size(): number;
  /** 关闭所有连接（服务退出时调用）。 */
  closeAll(): void;
}

/** 心跳间隔（毫秒）——定期发送注释行，防止中间代理因空闲断连。 */
const HEARTBEAT_MS = 30_000;

/** 创建一个 SSE 广播器。 */
export function createSseHub(): SseHub {
  /** 当前在线的所有 SSE 连接。 */
  const clients = new Set<ServerResponse>();

  /** 定期心跳：向每个连接写一行注释，保活长连接。 */
  const heartbeat = setInterval(() => {
    for (const res of clients) {
      // 注释行以 `:` 开头，客户端会忽略，仅用于保活
      res.write(': heartbeat\n\n');
    }
  }, HEARTBEAT_MS);
  // 心跳定时器不应阻止进程退出
  heartbeat.unref();

  return {
    handle(req, res) {
      // 升级为 SSE：text/event-stream + 禁用缓存 + 保持连接
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      // 先写一行注释，确保响应头立即下发、连接建立
      res.write(': connected\n\n');
      clients.add(res);

      // 客户端断开或连接出错 → 清理
      const cleanup = (): void => {
        clients.delete(res);
      };
      req.on('close', cleanup);
      res.on('close', cleanup);
      res.on('error', cleanup);
    },

    broadcast(event) {
      const line = `data: ${JSON.stringify(event)}\n\n`;
      for (const res of clients) {
        res.write(line);
      }
    },

    size: () => clients.size,

    closeAll() {
      clearInterval(heartbeat);
      for (const res of clients) {
        res.end();
      }
      clients.clear();
    },
  };
}
