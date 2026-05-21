/**
 * `board watch [--region <名>] [--since <seq>]` —— 订阅白板事件流。
 *
 * 连接正在运行的 board-server（默认 `127.0.0.1:4500`，可用 `--port` 覆盖），
 * 把结构化事件以 NDJSON（每行一个 JSON 对象）持续输出到 stdout，供 Agent /
 * 脚本订阅（specs/CLI与MCP规格.md §5）。需先有 server 在跑。
 *
 *  - `--since <seq>`：先从事件日志回补 seq 之后的历史事件，再接入实时流。
 *  - `--region <名>`：只输出 payload.region 命中该区域的事件。
 *
 * 本命令长驻 —— 直到 server 关闭连接或用户 Ctrl-C。诊断信息走 stderr，
 * stdout 只输出纯 NDJSON 事件，便于下游管道消费。
 */
import type { ParsedArgs } from '../util/args.js';
import { CliError, EXIT } from '../util/io.js';

/** server 默认端口（与 board-server BOARD_PORT 默认一致）。 */
const DEFAULT_PORT = '4500';

/** 事件流的一帧 —— 只关心 seq / type / payload。 */
interface WatchEvent {
  seq?: number;
  type?: string;
  payload?: Record<string, unknown>;
}

/** 事件是否命中区域过滤（无 --region 时恒为 true）。 */
function matchRegion(evt: WatchEvent, region: string | undefined): boolean {
  if (!region) return true;
  return !!evt.payload && evt.payload['region'] === region;
}

/** 输出一条结构化事件为 NDJSON；非结构化帧（board-changed / 心跳）跳过。 */
function printEvent(evt: WatchEvent, region: string | undefined): void {
  if (typeof evt.seq !== 'number') return;
  if (!matchRegion(evt, region)) return;
  process.stdout.write(JSON.stringify(evt) + '\n');
}

/** 无法连接 server 时的统一报错。 */
function notRunning(base: string): CliError {
  return new CliError(
    `无法连接 board-server（${base}）—— 请确认 server 正在运行。`,
    EXIT.GENERAL,
  );
}

/** `board watch` —— 长驻订阅事件流。Promise 在连接关闭前不会 resolve。 */
export async function runWatch(args: ParsedArgs): Promise<number> {
  const port =
    args.options.get('port') ?? process.env['BOARD_PORT'] ?? DEFAULT_PORT;
  const base = `http://127.0.0.1:${port}`;
  const region = args.options.get('region');
  const sinceRaw = args.options.get('since');

  // ── 回补：先从事件日志拉取 since 之后的历史事件 ──────────────
  if (sinceRaw !== undefined) {
    const since = Number(sinceRaw);
    if (!Number.isFinite(since)) {
      throw new CliError('--since 必须是数字（事件 seq）', EXIT.USAGE);
    }
    const qs = new URLSearchParams({ since: String(since) });
    if (region) qs.set('region', region);
    let events: WatchEvent[] = [];
    try {
      const r = await fetch(`${base}/api/events/log?${qs.toString()}`);
      const env = (await r.json()) as {
        ok?: boolean;
        data?: { events?: WatchEvent[] };
      };
      if (env.ok && env.data?.events) events = env.data.events;
    } catch {
      throw notRunning(base);
    }
    for (const evt of events) printEvent(evt, region);
  }

  // ── 实时流：SSE 长连接 ───────────────────────────────────────
  let res: Response;
  try {
    res = await fetch(`${base}/api/events`, {
      headers: { Accept: 'text/event-stream' },
    });
  } catch {
    throw notRunning(base);
  }
  if (!res.ok || !res.body) {
    throw new CliError(`事件流连接失败（HTTP ${res.status}）`, EXIT.GENERAL);
  }
  process.stderr.write(`[board watch] 已连接 ${base}/api/events\n`);

  // 逐块读取 SSE 流，按空行（\n\n）切分事件帧，取 data: 行解析。
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const json = line.slice(5).trim();
        if (!json) continue;
        try {
          printEvent(JSON.parse(json) as WatchEvent, region);
        } catch {
          // 非 JSON 帧（如注释 / 心跳）忽略。
        }
      }
    }
  }
  process.stderr.write('[board watch] 事件流已关闭。\n');
  return EXIT.OK;
}
