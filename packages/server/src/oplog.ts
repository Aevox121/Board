/**
 * 操作日志 —— 磁盘上的 append-only 写操作流水（PRD §6.9
 * `history/oplog.jsonl`）。
 *
 * 每行一份 JSON：`{ ts, actor, op, details?, summary? }`。仅记结构化的
 * 「谁、何时、做了什么」，不替代 Y.Doc 的字段级版本（撤销 / 复原走
 * snapshot + UndoManager）。oplog 的价值是离线审计、Agent / 协作者复盘
 * 「这板上谁动了什么」、按时间倒序追溯异常修改。
 *
 * 写策略：单次 append 一行，UTF-8 + LF。文件不打开常驻句柄 ——
 * Node 的 appendFile 内部按需打开。失败仅 console.error，不阻塞主链路
 * （oplog 是辅助、不在关键路径）。
 *
 * 读策略：tail 时整文件读入再按行 reverse 取末尾 N 条。Board 单白板
 * oplog 通常 < 几 MB，整读够用；后续如有大日志再换 reverse-stream 读。
 */
import { promises as fs, constants as fsConstants } from 'node:fs';
import { join } from 'node:path';

/** 一条 oplog 记录。 */
export interface OpEntry {
  /** ISO 时间戳。 */
  ts: string;
  /** 操作者参与者 id 或系统标识。 */
  actor: string;
  /** 操作类型 —— 自由文本，常见值见 OP_CHANGE / OP_RECONCILE 等。 */
  op: string;
  /** 操作附加信息（任意 JSON 可序列化对象）。 */
  details?: Record<string, unknown>;
}

/** 常用 op 类型 —— 调用方建议常量化以便后期检索。 */
export const OP_CHANGE = 'change';
export const OP_RECONCILE = 'reconcile';
export const OP_SNAPSHOT = 'snapshot';
export const OP_RESTORE = 'restore';
export const OP_TASK = 'task';
export const OP_SUGGESTION = 'suggestion';

/** oplog 对外句柄。 */
export interface OpLog {
  /** 追加一条记录。失败仅记 stderr，不抛错。 */
  append(entry: Omit<OpEntry, 'ts'>): Promise<void>;
  /** 取末尾 n 条（按时间倒序：最近的在前）。 */
  tail(n: number): Promise<OpEntry[]>;
  /** oplog 文件绝对路径（调试 / CLI 直读用）。 */
  readonly path: string;
}

/** 把一行 JSON 解析为 OpEntry；失败返回 null（行损坏时跳过不报错）。 */
function parseLine(line: string): OpEntry | null {
  if (!line.trim()) return null;
  try {
    const obj = JSON.parse(line) as OpEntry;
    if (typeof obj.ts === 'string' && typeof obj.actor === 'string' && typeof obj.op === 'string') {
      return obj;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 创建 oplog 句柄；`<boardDir>/history/oplog.jsonl` 不存在时按需建立。
 */
export async function createOpLog(boardDir: string): Promise<OpLog> {
  const dir = join(boardDir, 'history');
  const path = join(dir, 'oplog.jsonl');
  // 启动期保证目录存在；不预创建空文件（首次 append 自动建）。
  await fs.mkdir(dir, { recursive: true });

  return {
    path,
    async append(entry) {
      const line =
        JSON.stringify({
          ts: new Date().toISOString(),
          ...entry,
        }) + '\n';
      try {
        await fs.appendFile(path, line, { encoding: 'utf8' });
      } catch (err) {
        console.error('[oplog] 写入失败（忽略，不阻塞主链路）:', err);
      }
    },
    async tail(n) {
      try {
        await fs.access(path, fsConstants.R_OK);
      } catch {
        return []; // 还没写过
      }
      let text: string;
      try {
        text = await fs.readFile(path, 'utf8');
      } catch (err) {
        console.error('[oplog] 读取失败:', err);
        return [];
      }
      const lines = text.split('\n');
      // 末尾 n 条按行倒序解析（最近在前）。
      const out: OpEntry[] = [];
      for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
        const entry = parseLine(lines[i]!);
        if (entry) out.push(entry);
      }
      return out;
    },
  };
}
