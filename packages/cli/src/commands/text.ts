/**
 * `board text <create|append>` —— Agent 流式编辑文本卡的命令面（PRD §7.4）。
 *
 * 与 `board add text "<完整正文>"` 区别：
 *  - add text 一次性写整片 markdown（atomic，原子写）
 *  - text create + text append 配合使用 ——「先开一张空卡 → 多次追加」，每次
 *    经 Y.Text.insert 字符级落入 server Y.Doc，所有 Web 客户端实时看到打字
 *    动画 + Agent 焦点光标按行号同步移动
 *
 * 典型 LLM 流式工作流（pseudo）：
 *   id = board text create --region 路线 --at 20,80 --size 600,200 --json
 *   for chunk in llm.stream("..."):
 *     board text append <id> "<chunk>"
 *
 * 两条命令都经 board-server HTTP（与 task / snapshot 一致），需要 server 在运行；
 * 离线无法用（CLI 的 add text 仍是离线兜底）。
 */
import type { ParsedArgs } from '../util/args.js';
import { CliError, EXIT, type CmdResult } from '../util/io.js';

const DEFAULT_ACTOR = 'a_agent';

interface Envelope<T> {
  ok: boolean;
  data: T | null;
  error: string | null;
}

function port(args: ParsedArgs): string {
  return args.options.get('port') ?? process.env['BOARD_PORT'] ?? '4500';
}

async function postJson<T>(
  args: ParsedArgs,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const p = port(args);
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${p}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new CliError(
      `无法连接 board-server（端口 ${p}）：${err instanceof Error ? err.message : String(err)}`,
      EXIT.GENERAL,
    );
  }
  let envelope: Envelope<T>;
  try {
    envelope = (await res.json()) as Envelope<T>;
  } catch {
    throw new CliError(`${path} 响应不是合法 JSON（HTTP ${res.status}）`, EXIT.GENERAL);
  }
  if (!res.ok || !envelope.ok) {
    throw new CliError(envelope.error ?? `HTTP ${res.status}`, EXIT.GENERAL);
  }
  if (envelope.data === null || envelope.data === undefined) {
    throw new CliError(`${path} 响应缺少 data 字段`, EXIT.GENERAL);
  }
  return envelope.data;
}

/** 解析 "x,y" 形式为 [x, y] 数字对。 */
function parseXY(s: string | undefined, key: string): [number, number] | null {
  if (!s) return null;
  const m = s.split(',').map((x) => Number(x.trim()));
  if (m.length !== 2 || m.some((v) => !Number.isFinite(v))) {
    throw new CliError(`--${key} 应为 "x,y" 形式（如 20,80）：${s}`, EXIT.USAGE);
  }
  return [m[0]!, m[1]!];
}

/**
 * `board text create [--region <名>] [--at x,y] [--size w,h] [--markdown "<初始>"] [--actor <id>]`
 *
 * 返回新建元素的 id（人读 text + JSON data）。
 */
async function textCreate(args: ParsedArgs): Promise<CmdResult> {
  const actor = args.options.get('actor') ?? DEFAULT_ACTOR;
  const region = args.options.get('region');
  const at = parseXY(args.options.get('at'), 'at');
  const size = parseXY(args.options.get('size'), 'size');
  const markdown = args.options.get('markdown') ?? '';

  const body: Record<string, unknown> = { actor, markdown };
  if (region) body['region'] = region;
  if (at) {
    body['x'] = at[0];
    body['y'] = at[1];
  }
  if (size) {
    body['width'] = size[0];
    body['height'] = size[1];
  }

  const data = await postJson<{ elementId: string }>(
    args,
    '/api/elements/text-create',
    body,
  );
  return {
    code: EXIT.OK,
    text: `已创建空文本卡 ${data.elementId}`,
    data,
  };
}

/**
 * `board text append <elementId> "<chunk>" [--line N] [--actor <id>]`
 *
 * 给已存在的 text 元素 markdown 追加一段；浏览器看到打字动画 + Agent 光标
 * 移到对应行 jitter。
 */
async function textAppend(args: ParsedArgs): Promise<CmdResult> {
  const elementId = args.positionals[0];
  const chunk = args.positionals[1];
  if (!elementId || chunk === undefined) {
    throw new CliError(
      '用法: board text append <elementId> "<chunk>" [--line N]',
      EXIT.USAGE,
    );
  }
  const actor = args.options.get('actor') ?? DEFAULT_ACTOR;
  const lineRaw = args.options.get('line');
  const lineIndex =
    lineRaw !== undefined && Number.isFinite(Number(lineRaw))
      ? Number(lineRaw)
      : undefined;

  const body: Record<string, unknown> = { actor, elementId, chunk };
  if (lineIndex !== undefined) body['lineIndex'] = lineIndex;

  const data = await postJson<{ ok: boolean; length: number; lineIndex: number }>(
    args,
    '/api/elements/text-append',
    body,
  );
  return {
    code: EXIT.OK,
    text: `已追加（当前 ${data.length} 字符，行 ${data.lineIndex}）`,
    data,
  };
}

/**
 * `board text set <elementId> --markdown "<新内容>" [--actor <id>]`
 *
 * 整体替换 text 元素的 markdown 内容。**走 server**(/api/elements/text-set,
 * Y.Text reset),不能 disk 直写 —— 否则 Y.Doc 持旧值会反过来覆盖刚写的盘。
 */
async function textSet(args: ParsedArgs): Promise<CmdResult> {
  const elementId = args.positionals[0];
  if (!elementId) {
    throw new CliError(
      '用法: board text set <elementId> --markdown "<新内容>"',
      EXIT.USAGE,
    );
  }
  const markdown = args.options.get('markdown');
  if (markdown === undefined) {
    throw new CliError('缺少 --markdown', EXIT.USAGE);
  }
  const actor = args.options.get('actor') ?? DEFAULT_ACTOR;

  const data = await postJson<{ ok: boolean; length: number }>(
    args,
    '/api/elements/text-set',
    { actor, elementId, markdown },
  );
  return {
    code: EXIT.OK,
    text: `已整体替换 markdown（${data.length} 字符）`,
    data: { elementId, ...data },
  };
}

/** 执行 text 命令。 */
export async function cmdText(args: ParsedArgs): Promise<CmdResult> {
  const sub = args.positionals[0];
  if (sub === undefined) {
    throw new CliError(
      '缺少子命令。用法: board text create|append|set ...',
      EXIT.USAGE,
    );
  }
  const subArgs: ParsedArgs = {
    positionals: args.positionals.slice(1),
    flags: args.flags,
    options: args.options,
  };
  switch (sub) {
    case 'create':
      return textCreate(subArgs);
    case 'append':
      return textAppend(subArgs);
    case 'set':
      return textSet(subArgs);
    default:
      throw new CliError(
        `未知子命令 "text ${sub}"。可用: create, append, set`,
        EXIT.USAGE,
      );
  }
}
