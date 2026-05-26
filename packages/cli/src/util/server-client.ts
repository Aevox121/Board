/**
 * board-server HTTP 客户端 —— CLI 在服务存活时绕过 fs、走 server API。
 *
 * 为什么:
 *   server 用 Y.Doc 作为运行态权威源,300ms 节流投影回 board.json。
 *   若 CLI 也直接 fs.writeFile(board.json),server 内存仍是旧版,且下次投影
 *   会把磁盘上的新数据覆盖回旧的 —— 数据竞争 + 反向丢写。
 *
 * 解法:
 *   CLI 先探测 127.0.0.1:4500 (可经 BOARD_SERVER_URL 覆盖) 是否在跑且管着
 *   当前 .board;在跑就走 GET/PUT /api/boards/<id>/board,服务自己处理 Y.Doc
 *   / 落盘 / 广播;不在跑回退 loadBoard + saveBoard。
 */
import { resolve } from 'node:path';
import type { BoardMeta, BoardScene } from '@board/core';

/** 默认 server 地址 —— 与 Dev/CLAUDE.md 端口登记表 board-server 一致。 */
const DEFAULT_BASE_URL = 'http://127.0.0.1:4500';
/** 探测超时 —— server 不在时尽快放弃,别拖慢 CLI。 */
const PROBE_TIMEOUT_MS = 800;
/** 读 / 写超时 —— 取定后给出宽裕窗口供 server 完成 reconcile + 广播。 */
const RW_TIMEOUT_MS = 10_000;

/** 服务侧 BoardSummary 的客户端镜像(只用得上 id/dir)。 */
interface BoardListItem {
  id: string;
  dir: string;
}

/**
 * 一个已锁定到某 boardId 的 server 句柄 —— CLI 命令拿它读写白板。
 */
export interface ServerHandle {
  /** server 根地址(例: http://127.0.0.1:4500)。 */
  baseUrl: string;
  /** server 内此白板的 id(派生自目录名)。 */
  boardId: string;
  /** GET /api/boards/<id>/board → { meta, scene }。 */
  fetchBoard(): Promise<{ meta: BoardMeta; scene: BoardScene }>;
  /** PUT /api/boards/<id>/board { scene } —— 整场景写入。 */
  putBoard(scene: BoardScene): Promise<void>;
  /** POST /api/boards/<id>/refresh —— 外部写 files/ 后触发服务比对事件流。 */
  refresh(actor?: string): Promise<void>;
  /**
   * POST /api/boards/<id>/agent-activity —— 告诉服务"有 Agent 在干活"。
   * 服务会自动注册 participant(如缺)+ 推一帧 presence,Web 端据此渲染
   * Agent 头像与围绕 targetElementId 的轨道动画(PRD §7.4 / §8.2)。
   */
  agentActivity(opts: AgentActivityInput): Promise<void>;
}

/** /api/agent-activity 请求体的客户端镜像。 */
export interface AgentActivityInput {
  /** Agent id —— 必须以 `a_` 开头(server 端硬约束)。 */
  actorId: string;
  /** 显示名;省略时 server 用 actorId 兜底。 */
  name?: string;
  /** 主题色 hex(如 `#1971C2`);省略时 server 用默认蓝。 */
  color?: string;
  /** 让光标钉到此元素,触发轨道动画(PRD §8.2)。 */
  targetElementId?: string;
  /** 自由光标位置;不传则取 server 默认行为(无光标 → 仅显示头像)。 */
  cursor?: { x: number; y: number };
}

/** envelope: { ok, data, error } —— GET/PUT/POST /api 端点统一格式。 */
interface Envelope<T> {
  ok: boolean;
  data: T | null;
  error: string | null;
}

/** 路径规范化 —— 用于把 CLI 解析出的 dir 与 server 报的 dir 对比。 */
function canonicalize(p: string): string {
  // Windows 不区分大小写 + 正反斜杠都用过 —— 全部小写并把反斜杠转正斜杠。
  return resolve(p).replace(/\\/g, '/').toLowerCase();
}

/** 带超时的 fetch —— Node 18+ 自带 AbortController。 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 取 BOARD_SERVER_URL 或默认值。 */
function getBaseUrl(): string {
  const override = process.env.BOARD_SERVER_URL?.trim();
  return (override && override.replace(/\/+$/, '')) || DEFAULT_BASE_URL;
}

/**
 * 试着在本机 board-server 上找到管理 `boardDir` 的 board。
 *
 * 找到 → 返回 ServerHandle;
 * 找不到(server 离线 / 没管这个 .board) → 返回 null,调用方应回退 fs 路径。
 *
 * 注意:任何网络异常都吞掉返 null —— "服务不可达"就是 CLI 退回本地写的信号,
 * 不能让探测错误冒到 CLI 退出码上,否则离线场景会比在线还难用。
 */
export async function findServerForBoard(
  boardDir: string,
): Promise<ServerHandle | null> {
  const baseUrl = getBaseUrl();
  let listResp: Response;
  try {
    listResp = await fetchWithTimeout(
      `${baseUrl}/api/boards`,
      { method: 'GET' },
      PROBE_TIMEOUT_MS,
    );
  } catch {
    return null; // 连不上 → server 不在
  }
  if (!listResp.ok) return null;

  let boards: BoardListItem[];
  try {
    const body = (await listResp.json()) as { boards?: BoardListItem[] };
    boards = body.boards ?? [];
  } catch {
    return null;
  }

  const wantedKey = canonicalize(boardDir);
  const match = boards.find((b) => canonicalize(b.dir) === wantedKey);
  if (!match) return null;

  return createHandle(baseUrl, match.id);
}

function createHandle(baseUrl: string, boardId: string): ServerHandle {
  const prefix = `${baseUrl}/api/boards/${encodeURIComponent(boardId)}`;

  async function unwrap<T>(resp: Response, op: string): Promise<T> {
    let body: Envelope<T>;
    try {
      body = (await resp.json()) as Envelope<T>;
    } catch (err) {
      throw new Error(
        `board-server ${op} 响应解析失败 (HTTP ${resp.status}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (!resp.ok || !body.ok) {
      throw new Error(
        `board-server ${op} 失败 (HTTP ${resp.status}): ${body.error ?? '未知错误'}`,
      );
    }
    return body.data as T;
  }

  return {
    baseUrl,
    boardId,

    async fetchBoard(): Promise<{ meta: BoardMeta; scene: BoardScene }> {
      const resp = await fetchWithTimeout(
        `${prefix}/board`,
        { method: 'GET' },
        RW_TIMEOUT_MS,
      );
      const data = await unwrap<{ meta: BoardMeta; scene: BoardScene }>(
        resp,
        'GET /board',
      );
      return { meta: data.meta, scene: data.scene };
    },

    async putBoard(scene: BoardScene): Promise<void> {
      const resp = await fetchWithTimeout(
        `${prefix}/board`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scene }),
        },
        RW_TIMEOUT_MS,
      );
      await unwrap<{ saved: true }>(resp, 'PUT /board');
    },

    async refresh(actor?: string): Promise<void> {
      const resp = await fetchWithTimeout(
        `${prefix}/refresh`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(actor ? { actor } : {}),
        },
        RW_TIMEOUT_MS,
      );
      await unwrap<{ refreshed: true }>(resp, 'POST /refresh');
    },

    async agentActivity(opts: AgentActivityInput): Promise<void> {
      // server 端硬约束 —— 提前挡掉,避免无谓的 400 出现在日志里。
      if (!opts.actorId.startsWith('a_')) return;
      const resp = await fetchWithTimeout(
        `${prefix}/agent-activity`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(opts),
        },
        RW_TIMEOUT_MS,
      );
      await unwrap<{ actorId: string; registered: boolean }>(
        resp,
        'POST /agent-activity',
      );
    },
  };
}
