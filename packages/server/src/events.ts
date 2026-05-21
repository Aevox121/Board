/**
 * 事件日志 —— 服务端的事件环形缓冲（specs/CLI与MCP规格.md §5）。
 *
 * 职责：
 *  - 为每条事件草稿（`DraftEvent`）补上单调 `seq` 与 `ts`；
 *  - 保留最近 `CAP` 条事件，供 `board_subscribe_events` 按游标增量拉取
 *    （`GET /api/events/log?since=<seq>`）。
 *
 * 实时推送由 SSE 负责（见 sse.ts）；本模块只管「编号 + 留存」。
 */
import type { BoardEvent, DraftEvent } from '@board/core';

/** 环形缓冲容量 —— 超出后丢弃最旧事件。 */
const CAP = 1000;

/** 事件日志对外句柄。 */
export interface EventLog {
  /** 追加一批事件草稿，补 seq / ts 后返回编号好的事件。 */
  append(drafts: DraftEvent[]): BoardEvent[];
  /** 取 `seq` 大于 `since` 的全部留存事件（增量拉取）。 */
  since(since: number): BoardEvent[];
  /** 当前最大 seq（游标）。 */
  cursor(): number;
}

/** 创建一个事件日志。 */
export function createEventLog(): EventLog {
  /** 已编号事件的环形缓冲（按 seq 升序）。 */
  const buf: BoardEvent[] = [];
  /** 单调递增的事件序号。 */
  let seq = 0;

  return {
    append(drafts) {
      const ts = new Date().toISOString();
      const out: BoardEvent[] = [];
      for (const d of drafts) {
        seq += 1;
        const evt: BoardEvent = {
          seq,
          type: d.type,
          actor: d.actor,
          ts,
          payload: d.payload,
        };
        buf.push(evt);
        out.push(evt);
      }
      // 超出容量 → 丢弃最旧事件（订阅方游标落后过多时会漏读，可接受）。
      while (buf.length > CAP) buf.shift();
      return out;
    },

    since(since) {
      return buf.filter((e) => e.seq > since);
    },

    cursor: () => seq,
  };
}
