/**
 * 输出与退出码工具 — 见 specs/CLI与MCP规格.md §1.3/§1.4。
 *
 * 所有命令统一经由本模块产出结果：
 * - 默认人类可读文本；
 * - `--json` 时输出 `{ ok, data, error }` 信封。
 */

/** 退出码约定（规格 §1.4）。 */
export const EXIT = {
  /** 成功 */
  OK: 0,
  /** 一般错误 */
  GENERAL: 1,
  /** 参数错误 */
  USAGE: 2,
  /** 白板不存在 / 未找到 */
  NOT_FOUND: 3,
  /** 冲突 */
  CONFLICT: 4,
  /** 权限不足 */
  PERMISSION: 5,
} as const;

/** 命令执行结果——退出码必给，文本/数据按需。 */
export interface CmdResult {
  /** 进程退出码 */
  code: number;
  /** 人类可读文本（非 --json 模式输出） */
  text?: string;
  /** 机器可读数据（--json 模式作为 data 字段） */
  data?: unknown;
}

/**
 * 带退出码的错误——命令内部抛出后由路由统一捕获，
 * 转成对应退出码与 JSON 信封的 error。
 */
export class CliError extends Error {
  readonly code: number;

  constructor(message: string, code: number = EXIT.GENERAL) {
    super(message);
    this.name = 'CliError';
    this.code = code;
  }
}

/** `{ ok, data, error }` JSON 信封（规格 §1.3）。 */
export interface JsonEnvelope {
  ok: boolean;
  data: unknown;
  error: string | null;
}

/** 成功时打印结果：--json 输出信封，否则输出文本。 */
export function emitSuccess(result: CmdResult, json: boolean): void {
  if (json) {
    const envelope: JsonEnvelope = {
      ok: true,
      data: result.data ?? null,
      error: null,
    };
    console.log(JSON.stringify(envelope));
  } else if (result.text !== undefined) {
    console.log(result.text);
  }
}

/** 失败时打印结果：--json 输出信封，否则输出错误文本到 stderr。 */
export function emitError(message: string, json: boolean): void {
  if (json) {
    const envelope: JsonEnvelope = { ok: false, data: null, error: message };
    console.log(JSON.stringify(envelope));
  } else {
    console.error(`错误: ${message}`);
  }
}
