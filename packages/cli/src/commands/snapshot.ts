/**
 * `board snapshot <create|ls|rm>` 与 `board restore <id>` ——
 * 存档复原（PRD §8.5），经运行中的 board-server 操作。
 *
 * 规格 §2.6：
 *   board snapshot create [--name "<名>"]
 *   board snapshot ls
 *   board snapshot rm <snapshotId>
 *   board restore <snapshotId>
 *
 * 写操作在 server 端：建档把当前 board.json/meta.json/files/ 完整复制
 * 进 history/snapshots/<id>/；复原前先自动建 pre-restore 档、再把当前
 * 整套换回快照内容，Y.Doc 由 server 重新同步给所有 ws 客户端。
 */
import type { ParsedArgs } from '../util/args.js';
import { CliError, EXIT, type CmdResult } from '../util/io.js';

const DEFAULT_PORT = '4500';

function serverBase(args: ParsedArgs): string {
  const port =
    args.options.get('port') ?? process.env['BOARD_PORT'] ?? DEFAULT_PORT;
  return `http://127.0.0.1:${port}`;
}

interface Envelope {
  ok?: boolean;
  data?: unknown;
  error?: string | null;
}

async function callServer(
  method: string,
  url: string,
  body?: unknown,
): Promise<unknown> {
  let res;
  try {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    res = await fetch(url, init);
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
    /* 响应非 JSON —— 落到下面统一报错 */
  }
  if (!res.ok || env.ok !== true) {
    throw new CliError(
      env.error ?? `请求失败（HTTP ${res.status}）`,
      EXIT.GENERAL,
    );
  }
  return env.data;
}

interface SnapEntry {
  id: string;
  name: string;
  createdBy: string;
  createdAt: string;
  auto: boolean;
}

/** board snapshot <sub> [...] —— 子命令分发。 */
export async function cmdSnapshot(args: ParsedArgs): Promise<CmdResult> {
  const [sub, ...rest] = args.positionals;
  if (sub === 'create') {
    const name = args.options.get('name') ?? null;
    const actor = args.options.get('actor') ?? 'u_local';
    const data = (await callServer(
      'POST',
      `${serverBase(args)}/api/snapshots`,
      { name, actor },
    )) as { snapshot: SnapEntry };
    return {
      code: EXIT.OK,
      text:
        `已建快照 ${data.snapshot.id} ${data.snapshot.name}（${data.snapshot.auto ? '自动' : '手动'}）`,
      data,
    };
  }
  if (sub === 'ls') {
    const data = (await callServer('GET', `${serverBase(args)}/api/snapshots`)) as {
      snapshots: SnapEntry[];
    };
    if (data.snapshots.length === 0) {
      return { code: EXIT.OK, text: '（尚无快照）', data };
    }
    const lines = data.snapshots.map(
      (s) =>
        `  ${s.id}  ${s.auto ? '◷ 自动' : '★ 手动'}  ${s.name}  · ${s.createdAt.slice(0, 19)} · ${s.createdBy}`,
    );
    return {
      code: EXIT.OK,
      text: `共 ${data.snapshots.length} 份快照：\n${lines.join('\n')}`,
      data,
    };
  }
  if (sub === 'rm') {
    const id = rest[0];
    if (!id) {
      throw new CliError('用法: board snapshot rm <snapshotId>', EXIT.USAGE);
    }
    await callServer('DELETE', `${serverBase(args)}/api/snapshots/${encodeURIComponent(id)}`);
    return { code: EXIT.OK, text: `已删除快照 ${id}`, data: { id } };
  }
  throw new CliError(
    '用法: board snapshot <create|ls|rm> ...',
    EXIT.USAGE,
  );
}

/** board restore <snapshotId> —— 一键复原（PRD §8.5）。 */
export async function cmdRestore(args: ParsedArgs): Promise<CmdResult> {
  const id = args.positionals[0];
  if (!id) {
    throw new CliError('用法: board restore <snapshotId>', EXIT.USAGE);
  }
  const actor = args.options.get('actor') ?? 'u_local';
  const data = (await callServer(
    'POST',
    `${serverBase(args)}/api/snapshots/${encodeURIComponent(id)}/restore`,
    { actor },
  )) as { restored: string; preRestoreSnapshotId: string };
  return {
    code: EXIT.OK,
    text: `已复原到 ${data.restored}（复原前自动档：${data.preRestoreSnapshotId}）`,
    data,
  };
}
