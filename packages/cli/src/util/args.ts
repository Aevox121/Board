/**
 * 命令行参数解析 — 见 specs/CLI与MCP规格.md §1.2。
 *
 * 极简实现，零依赖：
 * - `--flag` 布尔开关；
 * - `--key value` 取值选项；
 * - 其余视为位置参数。
 */

/** 解析后的参数集合。 */
export interface ParsedArgs {
  /** 位置参数（按出现顺序） */
  positionals: string[];
  /** 布尔开关：出现即为 true */
  flags: Set<string>;
  /** 取值选项：`--key value` */
  options: Map<string, string>;
}

/**
 * 解析参数。
 *
 * @param argv     待解析参数（已去掉命令名）
 * @param valueKeys 需要取值的选项名集合（不含 `--` 前缀）；
 *                  不在此集合内的 `--xxx` 一律按布尔开关处理。
 */
export function parseArgs(
  argv: string[],
  valueKeys: ReadonlySet<string>,
): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Set<string>();
  const options = new Map<string, string>();

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;

    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq !== -1) {
        // --key=value 形式
        const key = token.slice(2, eq);
        options.set(key, token.slice(eq + 1));
        continue;
      }
      const key = token.slice(2);
      if (valueKeys.has(key)) {
        // --key value 形式：吞掉下一个 token 作为值
        const next = argv[i + 1];
        options.set(key, next ?? '');
        i++;
      } else {
        flags.add(key);
      }
    } else {
      positionals.push(token);
    }
  }

  return { positionals, flags, options };
}

/** 所有命令通用的取值选项（规格 §1.2 全局选项）。 */
export const GLOBAL_VALUE_KEYS: ReadonlySet<string> = new Set([
  'board',
  'board-id',
  'actor',
  'dir',
  'depth',
  'format',
  'region',
  'at',
  'force-at',
  'to',
  'display',
  'port',
  'host',
  'scheme',
  'out',
  'name',
  'label',
  'arrow',
  'routing',
  'type',
  'as',
  'reason',
  'stroke',
  'fill',
  'stroke-width',
  'stroke-style',
  'opacity',
  'desc',
  'parent',
  'size',
  'agent',
  'agent-name',
  'agent-color',
  'owner',
  'line',
  'markdown',
  'tail',
  'title',
  'step',
  'percent',
  'summary',
  'task',
  'text',
  'role',
  'ids',
  'layout',
  'gap',
  'cols',
  'nodes',
  'edges',
  'direction',
]);
