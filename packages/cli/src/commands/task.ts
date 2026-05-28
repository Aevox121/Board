/**
 * `board task <start|progress|finish> ...` — Agent 任务（Pencil 式过程可视化）。
 *
 * 任务是运行时态，由正在运行的 board-server 持有 —— 本命令经 HTTP 调用 server
 * （默认 `127.0.0.1:4500`，可用 `--port` 覆盖）。需先有 server 在跑。
 *
 * 规格 §2.5：
 *   board task start --title "<做什么>" [--region <名>] [--at <x,y>] [--agent <id>]
 *   board task progress <taskId> --step "<步骤>" [--percent <n>]
 *   board task finish <taskId> [--summary "<结果说明>"]
 */
import type { ParsedArgs } from '../util/args.js';
import { CliError, EXIT, type CmdResult } from '../util/io.js';
import { apiPrefix } from '../util/server-api-prefix.js';

/** server 默认端口（与 board-server BOARD_PORT 默认一致）。 */
const DEFAULT_PORT = '4500';

/** server 基址 —— `--port` 优先，其次 `BOARD_PORT`，默认 4500。 */
function serverBase(args: ParsedArgs): string {
  const port =
    args.options.get('port') ?? process.env['BOARD_PORT'] ?? DEFAULT_PORT;
  return `http://127.0.0.1:${port}`;
}

/** server 统一响应信封。 */
interface Envelope {
  ok?: boolean;
  data?: unknown;
  error?: string | null;
}

/** POST JSON 到 server，返回 data 字段；网络失败 / 非 ok 抛 CliError。 */
async function postJson(url: string, body: unknown): Promise<unknown> {
  let res: { ok: boolean; status: number; json(): Promise<unknown> };
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new CliError(
      `无法连接 board-server（${url}）—— 请确认 server 正在运行。`,
      EXIT.GENERAL,
    );
  }
  let env: Envelope = {};
  try {
    env = (await res.json()) as Envelope;
  } catch {
    // 响应非 JSON —— 落到下方统一报错。
  }
  if (!res.ok || env.ok !== true) {
    throw new CliError(env.error ?? `请求失败（HTTP ${res.status}）`, EXIT.GENERAL);
  }
  return env.data;
}

/** 解析 `--at "x,y"` → `[x,y]`；缺省 / 非法返回 null。 */
function parseAt(raw: string | undefined): [number, number] | null {
  if (!raw) return null;
  const parts = raw.split(',').map((s) => Number(s.trim()));
  const a = parts[0];
  const b = parts[1];
  if (
    parts.length === 2 &&
    a !== undefined &&
    b !== undefined &&
    Number.isFinite(a) &&
    Number.isFinite(b)
  ) {
    return [a, b];
  }
  return null;
}

/** board task start —— 新建任务，返回 taskId。 */
async function taskStart(args: ParsedArgs): Promise<CmdResult> {
  const title = args.options.get('title');
  if (!title) {
    throw new CliError(
      '缺少 --title。用法: board task start --title "<做什么>" [--region <名>]',
      EXIT.USAGE,
    );
  }
  const body: Record<string, unknown> = { title };
  const agent = args.options.get('agent') ?? args.options.get('actor');
  if (agent) body['agentId'] = agent;
  const region = args.options.get('region');
  if (region) body['region'] = region;
  const at = parseAt(args.options.get('at'));
  if (at) body['at'] = at;

  const data = (await postJson(`${serverBase(args)}${apiPrefix(args)}/tasks`, body)) as {
    taskId: string;
  };
  return {
    code: EXIT.OK,
    text: `已创建任务 ${data.taskId}`,
    data,
  };
}

/** board task progress <taskId> —— 上报进度。 */
async function taskProgress(args: ParsedArgs): Promise<CmdResult> {
  const taskId = args.positionals[1];
  if (!taskId) {
    throw new CliError(
      '缺少 taskId。用法: board task progress <taskId> --step "<步骤>" [--percent <n>]',
      EXIT.USAGE,
    );
  }
  const body: Record<string, unknown> = { taskId };
  const step = args.options.get('step');
  if (step) body['step'] = step;
  const percentRaw = args.options.get('percent');
  if (percentRaw !== undefined) {
    const p = Number(percentRaw);
    if (!Number.isFinite(p)) {
      throw new CliError('--percent 必须是数字', EXIT.USAGE);
    }
    body['percent'] = p;
  }
  await postJson(`${serverBase(args)}${apiPrefix(args)}/tasks/progress`, body);
  return { code: EXIT.OK, text: `任务 ${taskId} 进度已更新`, data: { taskId } };
}

/** board task finish <taskId> —— 完成任务（draft 元素转 committed）。 */
async function taskFinish(args: ParsedArgs): Promise<CmdResult> {
  const taskId = args.positionals[1];
  if (!taskId) {
    throw new CliError(
      '缺少 taskId。用法: board task finish <taskId> [--summary "<结果说明>"]',
      EXIT.USAGE,
    );
  }
  const body: Record<string, unknown> = { taskId };
  const summary = args.options.get('summary');
  if (summary) body['summary'] = summary;
  await postJson(`${serverBase(args)}${apiPrefix(args)}/tasks/finish`, body);
  return { code: EXIT.OK, text: `任务 ${taskId} 已完成`, data: { taskId } };
}

/** `board task` 分发。 */
export async function cmdTask(args: ParsedArgs): Promise<CmdResult> {
  const sub = args.positionals[0];
  switch (sub) {
    case 'start':
      return taskStart(args);
    case 'progress':
      return taskProgress(args);
    case 'finish':
      return taskFinish(args);
    default:
      throw new CliError(
        `未知子命令 "task ${sub ?? ''}"。可用: start, progress, finish`,
        EXIT.USAGE,
      );
  }
}
