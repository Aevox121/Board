/**
 * `board log [--tail <n>] [--port <p>] [--host <h>]` —— 读 oplog（PRD §6.9）。
 *
 * 从运行中的 board-server 拉 `GET /api/oplog?tail=N`；server 不在跑时回退
 * 到磁盘直读 `<board>/history/oplog.jsonl`（同款 reverse-tail 语义）。
 *
 * 输出格式（默认人类可读）每行：
 *   `<ts>  <actor>  <op>  <details summary>`
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { ParsedArgs } from '../util/args.js';
import { CliError, EXIT, type CmdResult } from '../util/io.js';
import { resolveBoardDir } from '../util/board.js';

interface OpEntry {
  ts: string;
  actor: string;
  op: string;
  details?: Record<string, unknown>;
}

/** server 不可达时的磁盘直读 fallback —— 与 server/oplog.ts:tail 同款。 */
async function tailFromDisk(dir: string, n: number): Promise<OpEntry[]> {
  const path = join(dir, 'history', 'oplog.jsonl');
  let text: string;
  try {
    text = await fs.readFile(path, 'utf8');
  } catch {
    return [];
  }
  const lines = text.split('\n');
  const out: OpEntry[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    try {
      out.push(JSON.parse(line) as OpEntry);
    } catch {
      // 损坏行跳过
    }
  }
  return out;
}

/** 优先经 HTTP 拉；server 不可达回退磁盘直读。 */
async function fetchTail(
  dir: string,
  n: number,
  host: string,
  port: string,
): Promise<{ entries: OpEntry[]; source: 'server' | 'disk' }> {
  try {
    const r = await fetch(`http://${host}:${port}/api/oplog?tail=${n}`);
    if (r.ok) {
      const j = (await r.json()) as {
        ok: boolean;
        data?: { entries?: OpEntry[] };
      };
      if (j.ok && j.data?.entries) {
        return { entries: j.data.entries, source: 'server' };
      }
    }
  } catch {
    // server 不可达 → fallback
  }
  return { entries: await tailFromDisk(dir, n), source: 'disk' };
}

function fmtDetails(d: Record<string, unknown> | undefined): string {
  if (!d) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(d)) {
    if (Array.isArray(v)) parts.push(`${k}=[${v.join(',')}]`);
    else parts.push(`${k}=${String(v)}`);
  }
  return parts.join(' ');
}

export async function cmdLog(args: ParsedArgs): Promise<CmdResult> {
  const boardPath = args.positionals[0];
  if (boardPath === undefined) {
    throw new CliError(
      '用法: board log <白板路径> [--tail <n>] [--port <p>] [--host <h>]',
      EXIT.USAGE,
    );
  }
  const dir = resolveBoardDir(boardPath, args.options.get('board'));
  const tailRaw = args.options.get('tail');
  const n = tailRaw !== undefined && Number.isFinite(Number(tailRaw))
    ? Math.min(1000, Math.max(1, Number(tailRaw) | 0))
    : 50;
  const host = args.options.get('host') ?? '127.0.0.1';
  const port = args.options.get('port') ?? '4500';

  const { entries, source } = await fetchTail(dir, n, host, port);

  if (entries.length === 0) {
    return {
      code: EXIT.OK,
      text:
        source === 'server'
          ? '（无操作日志记录）'
          : '（oplog 文件不存在或为空，且 board-server 未运行）',
      data: { entries: [], source },
    };
  }

  const lines = entries.map(
    (e) =>
      `${e.ts}  ${e.actor.padEnd(12)} ${e.op.padEnd(10)} ${fmtDetails(e.details)}`,
  );
  // 倒序拿到的最新在前；输出按时间顺序看更顺，反转一次。
  lines.reverse();
  const header = `oplog (tail ${entries.length}, source=${source}):`;
  return {
    code: EXIT.OK,
    text: [header, ...lines].join('\n'),
    data: { entries, source },
  };
}
