/**
 * board CLI — 路由层
 *
 * 命令清单与参数见 specs/CLI与MCP规格.md §2。
 * M1 已实现：new / info / ls / tree / show / add text。
 * M2 已实现：region create / region ls / add file / add folder / mv。
 * 其余命令保留为「尚未实现」占位，逐里程碑补全。
 *
 * 退出码（规格 §1.4）：0 成功 / 1 一般错误 / 2 参数错误
 *                     / 3 未找到 / 4 冲突 / 5 权限不足
 *
 * 注意：本模块由 index.ts 在注册 ESM 解析钩子后动态 import，
 *       因此其（及下游 commands/）的无扩展名 import 可正常解析。
 */
import { GLOBAL_VALUE_KEYS, parseArgs, type ParsedArgs } from './util/args.js';
import {
  CliError,
  EXIT,
  emitError,
  emitSuccess,
  type CmdResult,
} from './util/io.js';
import { cmdNew } from './commands/new.js';
import { cmdInfo } from './commands/info.js';
import { cmdLs } from './commands/ls.js';
import { cmdTree } from './commands/tree.js';
import { cmdShow } from './commands/show.js';
import { cmdAdd } from './commands/add.js';
import { cmdRegion } from './commands/region.js';
import { cmdMv } from './commands/mv.js';
import { cmdTask } from './commands/task.js';
import { cmdSuggest } from './commands/suggest.js';
import { cmdShape } from './commands/shape.js';
import { cmdConnect } from './commands/connect.js';
import { cmdRm } from './commands/rm.js';
import { cmdSearch } from './commands/search.js';
import { cmdComment } from './commands/comment.js';
import { cmdStyle } from './commands/style.js';
import { runMcpServer } from './commands/mcp.js';
import { runWatch } from './commands/watch.js';

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
  region: cmdRegion,
  mv: cmdMv,
  task: cmdTask,
  suggest: cmdSuggest,
  shape: cmdShape,
  connect: cmdConnect,
  rm: cmdRm,
  search: cmdSearch,
  comment: cmdComment,
  style: cmdStyle,
};

/** 已登记但尚未实现的命令（规格 §2，逐里程碑补全）。 */
const PLACEHOLDER_COMMANDS = [
  'open',
  'serve',
  'agent',
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
  console.log('  add text <路径> "<markdown>"      添加文本卡片元素');
  console.log('');
  console.log('已实现命令 (M2):');
  console.log('  region create <路径> <区域名> [--desc "<描述>"]   创建区域（建文件夹）');
  console.log('  region ls <路径>                                 列出所有区域');
  console.log('  add file <路径> <本地文件> [--region <区域名>]     复制文件入板');
  console.log('  add folder <路径> <本地目录> [--region <区域名>]   复制目录入板');
  console.log('  mv <路径> <源相对路径> <目标相对路径>             移动 files/ 内的文件');
  console.log('');
  console.log('已实现命令 (M3):');
  console.log('  show <路径> [--depth 0|1|2] [--region <名>]    导出白板上下文（渐进式披露）');
  console.log('  shape add <路径> <rectangle|ellipse|diamond> [--at x,y] [--label "<文字>"]   添加图形');
  console.log('  connect <路径> <源元素id> <目标元素id> [--label "<文字>"] [--arrow <样式>]    连线');
  console.log('  rm <路径> <元素id>                            删除元素（文件移入回收站）');
  console.log('  search <路径> "<关键词>"                      搜索元素文字 / 文件名 / 文件内容');
  console.log('  comment <路径> <元素id> "<文本>"              给元素加一条评论');
  console.log('  style <路径> <元素id> [--stroke <色>] [--fill <色>] [--opacity <n>]   改元素样式');
  console.log('  region describe <路径> <区域名> --desc "<描述>"     改区域描述');
  console.log('  region assign <路径> <区域名> --agent <id>          指派区域给 Agent');
  console.log('  suggest <路径> <元素id> --type <replace|add> --as text:"<md>"   创建建议');
  console.log('  add text <路径> "<markdown>" --draft          添加 draft 态文本卡');
  console.log('  mcp <路径> [--port <n>]                       启动 MCP Server (stdio)');
  console.log('');
  console.log('已实现命令 (M3，需 board-server 在运行):');
  console.log('  task start --title "<做什么>" [--region <名>] [--agent <id>]   新建 Agent 任务');
  console.log('  task progress <taskId> --step "<步骤>" [--percent <n>]         上报任务进度');
  console.log('  task finish <taskId> [--summary "<结果说明>"]                  完成任务');
  console.log('');
  console.log('已实现命令 (M4，需 board-server 在运行):');
  console.log('  watch [--region <名>] [--since <seq>]         订阅白板事件流（NDJSON）');
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

  // mcp —— 长驻 stdio MCP Server，不走「命令返回 CmdResult」的常规分发。
  if (cmd === 'mcp') {
    const boardPath = args.positionals[0];
    if (boardPath === undefined) {
      emitError('用法: board mcp <白板路径> [--port <n>]', json);
      return EXIT.USAGE;
    }
    const port =
      args.options.get('port') ?? process.env['BOARD_PORT'] ?? '4500';
    await runMcpServer(boardPath, port);
    return EXIT.OK;
  }

  // watch —— 长驻订阅事件流（NDJSON），不走「命令返回 CmdResult」的常规分发。
  if (cmd === 'watch') {
    try {
      return await runWatch(args);
    } catch (err) {
      if (err instanceof CliError) {
        emitError(err.message, json);
        return err.code;
      }
      emitError(err instanceof Error ? err.message : String(err), json);
      return EXIT.GENERAL;
    }
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
