/**
 * board CLI — 路由层
 *
 * 命令清单与参数见 specs/CLI与MCP规格.md §2。
 * M1 已实现：new / info / ls / tree / show / add text。
 * 其余命令保留为「尚未实现」占位，逐里程碑补全。
 *
 * 退出码（规格 §1.4）：0 成功 / 1 一般错误 / 2 参数错误
 *                     / 3 未找到 / 4 冲突 / 5 权限不足
 *
 * 注意：本模块由 index.ts 在注册 ESM 解析钩子后动态 import，
 *       因此其（及下游 commands/）的无扩展名 import 可正常解析。
 */
import { GLOBAL_VALUE_KEYS, parseArgs, type ParsedArgs } from './util/args';
import {
  CliError,
  EXIT,
  emitError,
  emitSuccess,
  type CmdResult,
} from './util/io';
import { cmdNew } from './commands/new';
import { cmdInfo } from './commands/info';
import { cmdLs } from './commands/ls';
import { cmdTree } from './commands/tree';
import { cmdShow } from './commands/show';
import { cmdAdd } from './commands/add';

/** 命令处理函数签名。 */
type Handler = (args: ParsedArgs) => Promise<CmdResult>;

/** 已实现命令的处理表。 */
const HANDLERS: Record<string, Handler> = {
  new: cmdNew,
  info: cmdInfo,
  ls: cmdLs,
  tree: cmdTree,
  show: cmdShow,
  add: cmdAdd,
};

/** 已登记但尚未实现的命令（规格 §2，逐里程碑补全）。 */
const PLACEHOLDER_COMMANDS = [
  'open',
  'serve',
  'region',
  'shape',
  'connect',
  'rm',
  'mv',
  'search',
  'suggest',
  'task',
  'comment',
  'agent',
  'watch',
  'snapshot',
  'restore',
  'export',
  'import',
  'share',
  'sync',
] as const;

/** 所有已登记顶层命令（已实现 + 占位）。 */
const ALL_COMMANDS: string[] = [
  ...Object.keys(HANDLERS),
  ...PLACEHOLDER_COMMANDS,
].sort();

/** 打印帮助。 */
function printHelp(): void {
  console.log('board <命令> [参数]');
  console.log('');
  console.log('全局选项:');
  console.log('  --board <path>   指定白板目录（省略时向上查找最近的 .board）');
  console.log('  --json           输出 { ok, data, error } JSON 信封');
  console.log('  --quiet          仅输出关键结果');
  console.log('  --actor <id>     以指定参与者身份执行');
  console.log('  --help, -h       显示帮助');
  console.log('');
  console.log('已实现命令 (M1):');
  console.log('  new <名称> [--dir <父目录>]        新建白板');
  console.log('  info <路径>                       查看白板元信息与统计');
  console.log('  ls                                列出当前目录及一层子目录的白板');
  console.log('  tree <路径>                       打印 files/ 文件树');
  console.log('  show <路径> [--json]              输出基础白板上下文');
  console.log('  add text <路径> "<markdown>"      添加文本卡片元素');
  console.log('');
  console.log('占位命令 (尚未实现):');
  console.log('  ' + PLACEHOLDER_COMMANDS.join(', '));
}

/** CLI 入口。 */
async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;

  if (cmd === undefined || cmd === '--help' || cmd === '-h') {
    printHelp();
    return EXIT.OK;
  }

  // 先解析参数，--json 在错误分支也要用到
  const args = parseArgs(rest, GLOBAL_VALUE_KEYS);
  const json = args.flags.has('json');

  if (args.flags.has('help')) {
    printHelp();
    return EXIT.OK;
  }

  // 未登记命令
  if (!ALL_COMMANDS.includes(cmd)) {
    emitError(`未知命令: ${cmd}（board --help 查看可用命令）`, json);
    return EXIT.USAGE;
  }

  // 已登记但未实现
  if (!(cmd in HANDLERS)) {
    emitError(`命令 "${cmd}" 尚未实现（将在后续里程碑补全）。`, json);
    return EXIT.GENERAL;
  }

  // 分发到已实现命令
  const handler = HANDLERS[cmd];
  if (handler === undefined) {
    emitError(`命令 "${cmd}" 尚未实现。`, json);
    return EXIT.GENERAL;
  }

  try {
    const result = await handler(args);
    emitSuccess(result, json);
    return result.code;
  } catch (err) {
    if (err instanceof CliError) {
      emitError(err.message, json);
      return err.code;
    }
    const message = err instanceof Error ? err.message : String(err);
    emitError(message, json);
    return EXIT.GENERAL;
  }
}

/** 由 bootstrap（index.ts）调用：执行 CLI 并退出进程。 */
export async function run(): Promise<void> {
  try {
    const code = await main(process.argv.slice(2));
    process.exit(code);
  } catch (err) {
    // 兜底：理论不可达，main 已捕获所有命令异常
    console.error(`未捕获错误: ${err instanceof Error ? err.message : err}`);
    process.exit(EXIT.GENERAL);
  }
}
