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
import { cmdRestore, cmdSnapshot } from './commands/snapshot.js';
import { cmdShare } from './commands/share.js';
import { cmdText } from './commands/text.js';
import { runWatch } from './commands/watch.js';
import { cmdExport } from './commands/export.js';
import { cmdImport } from './commands/import.js';
import { cmdServe } from './commands/serve.js';
import { cmdLog } from './commands/log.js';
import { cmdDelete } from './commands/delete.js';
import { cmdElement } from './commands/element.js';

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
  snapshot: cmdSnapshot,
  restore: cmdRestore,
  share: cmdShare,
  text: cmdText,
  export: cmdExport,
  import: cmdImport,
  serve: cmdServe,
  log: cmdLog,
  delete: cmdDelete,
  element: cmdElement,
};

/** 已登记但尚未实现的命令（规格 §2，逐里程碑补全）。 */
const PLACEHOLDER_COMMANDS = [
  'open',
  'agent',
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
  console.log('━━ Agent 使用约定（如果你是 AI Agent,务必看这里）━━');
  console.log('  写命令(add / shape / connect / region create / mv / rm / style /');
  console.log('  comment / suggest)必须自报家门,否则 Web 端的协作者看不到你的');
  console.log('  拟人化光标和操作动画 —— 写操作"无声"发生,人不知道是你做的:');
  console.log('');
  console.log('    board <写命令> ... \\');
  console.log('      --actor a_<你的标识>         # 必填,a_ 开头(server 硬约束)');
  console.log('      --agent-name "<显示名>" \\    # 可选,默认显示 actor id');
  console.log('      --agent-color "#xxxxxx"     # 可选,默认蓝色 #1971C2');
  console.log('');
  console.log('  例: board add text ./xxx.board "Hello" \\');
  console.log('       --actor a_claude_code --agent-name "Claude Code" --agent-color "#9b59b6"');
  console.log('');
  console.log('  Agent 标识建议形式:');
  console.log('    a_claude_code / a_codex / a_cursor / a_<你的工具名>_<会话短ID>');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('全局选项:');
  console.log('  --board <path>          指定白板目录（省略时向上查找最近的 .board）');
  console.log('  --json                  输出 { ok, data, error } JSON 信封');
  console.log('  --quiet                 仅输出关键结果');
  console.log('  --actor <id>            以指定参与者身份执行(Agent 必填,a_ 开头)');
  console.log('  --agent <id>            等价于 --actor,语义上强调 Agent 身份');
  console.log('  --agent-name "<显示名>" Agent 在 Web 端显示的名字');
  console.log('  --agent-color "#xxxxxx" Agent 头像 / 光标的主题色');
  console.log('  --help, -h              显示帮助');
  console.log('');
  console.log('已实现命令 (M1):');
  console.log('  new <名称> [--dir <父目录>]        新建白板');
  console.log('  delete <.board 目录>              删除白板（移到同级 _trash/）');
  console.log('  info <路径>                       查看白板元信息与统计');
  console.log('  ls [根目录]                       列出指定目录及一层子目录的白板');
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
  console.log('  element move <路径> <元素id> --to "x,y" [--size "w,h"]    按画布坐标摆位元素（connector 除外）');
  console.log('  region rm <路径> <区域名>                          删除区域（级联删内容 + 文件夹移回收站，可恢复）');
  console.log('  region describe <路径> <区域名> --desc "<描述>"     改区域描述');
  console.log('  region assign <路径> <区域名> --agent <id>          指派区域给 Agent');
  console.log('  suggest create <路径> <元素id> --type <replace|add> --as text:"<md>" [--reason ...]   创建建议');
  console.log('  suggest accept <路径> <suggestionId>                              同意建议');
  console.log('  suggest reject <路径> <suggestionId>                              拒绝建议');
  console.log('  suggest describe <路径> <suggestionId> --text "<反馈>" [--role human|agent]  向建议追加反馈');
  console.log('  add text <路径> "<markdown>" --draft          添加 draft 态文本卡');
  console.log('  mcp [boards-root] --actor a_<id> [--board <初始白板路径>] [--agent-name "<名>"] [--agent-color "#hex"] [--port <n>]');
  console.log('                                                启动 MCP Server (stdio)。多白板模式:可经 board_open_board 工具运行时切换');
  console.log('');
  console.log('已实现命令 (M3，需 board-server 在运行):');
  console.log('  task start --title "<做什么>" [--region <名>] [--agent <id>]   新建 Agent 任务');
  console.log('  task progress <taskId> --step "<步骤>" [--percent <n>]         上报任务进度');
  console.log('  task finish <taskId> [--summary "<结果说明>"]                  完成任务');
  console.log('');
  console.log('已实现命令 (M4，需 board-server 在运行):');
  console.log('  watch [--region <名>] [--since <seq>]         订阅白板事件流（NDJSON）');
  console.log('  snapshot create [--name "<名>"]               建一份存档点（PRD §8.5）');
  console.log('  snapshot ls                                  列出存档点');
  console.log('  snapshot rm <snapshotId>                     删除存档点');
  console.log('  restore <snapshotId>                         复原到指定存档点');
  console.log('  share <路径> [--host <host>] [--port <port>] 生成可分享的白板链接（PRD §4.2）');
  console.log('  text create [--region <名>] [--at x,y] [--size w,h] [--markdown "<初始>"]  开空文本卡（流式起手）');
  console.log('  text append <elementId> "<chunk>" [--line N]  追加 markdown（字符级 CRDT，浏览器看到打字 + Agent 光标）');
  console.log('  text set <elementId> --markdown "<新全文>"    整体替换 markdown（Y.Text reset，不动位置/尺寸/连线）');
  console.log('');
  console.log('已实现命令 (打包 / 导入 / 起服务):');
  console.log('  export <路径> [--json|--zip] [--out <文件>]   导出白板 JSON / zip（spec §2.6；--png/--svg/--html 暂未实现）');
  console.log('  import <zip 路径> [--name <名>] [--dir <父>]  从 zip 还原一个 .board');
  console.log('  serve <路径> [<路径>...] [--port <n>] [--host <addr>]  启动 board-server（多 .board 列出即中继）');
  console.log('  log <路径> [--tail <n>] [--port <p>] [--host <h>]  读取 oplog（PRD §6.9，server 不在跑时回退磁盘直读）');
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
  // 启动时绑定 Agent 身份：所有 MCP 工具操作自动套用，无需每次工具调用都带。
  //
  // 多白板模式(2026-05 起):位置参数 = boards-root(白板根目录,可选,缺省 cwd),
  // MCP 内部维护「当前白板」状态,可经 board_open_board 工具运行时切换;
  // 单个工具入参也可显式传 boardId/boardPath 覆盖。
  if (cmd === 'mcp') {
    // 位置参数 = boards-root(可选)。向后兼容:如果位置参数是个 .board 目录,
    // 自动拆成 boardsRoot=父目录,initialBoard=该 .board(等价老的「单白板」模式)。
    let boardsRoot = args.positionals[0];
    let initialBoard = args.options.get('board');
    if (boardsRoot !== undefined) {
      const { existsSync, statSync } = await import('node:fs');
      const { dirname, join, resolve, isAbsolute } = await import('node:path');
      const abs = isAbsolute(boardsRoot) ? boardsRoot : resolve(process.cwd(), boardsRoot);
      const looksLikeBoardDir = (() => {
        try {
          return statSync(abs).isDirectory() && existsSync(join(abs, 'board.json'));
        } catch { return false; }
      })();
      if (looksLikeBoardDir) {
        if (initialBoard === undefined) initialBoard = abs;
        boardsRoot = dirname(abs);
      }
    }
    const port =
      args.options.get('port') ?? process.env['BOARD_PORT'] ?? '4500';
    const actor =
      args.options.get('actor') ??
      args.options.get('agent') ??
      (process.env['BOARD_AGENT_ID']?.trim() || undefined);
    if (actor === undefined) {
      emitError(
        'board mcp 必须显式绑定 Agent 身份(spec §1.5):请加 --actor a_<id>,或设 BOARD_AGENT_ID env',
        json,
      );
      return EXIT.USAGE;
    }
    if (!actor.startsWith('a_')) {
      emitError(
        `actor "${actor}" 必须以 a_ 开头(server 端硬约束)`,
        json,
      );
      return EXIT.USAGE;
    }
    const agentName =
      args.options.get('agent-name') ??
      (process.env['BOARD_AGENT_NAME']?.trim() || undefined);
    const agentColor =
      args.options.get('agent-color') ??
      (process.env['BOARD_AGENT_COLOR']?.trim() || undefined);
    // 把 MCP 自己绑定的 board-server URL 落到 env,让 cmd*(走 openBoard 探 server)
    // 探得到正确端口。否则默认 :4500,如果 dev 时常驻一个老 server 在 4500 会撞到。
    process.env['BOARD_SERVER_URL'] = `http://127.0.0.1:${port}`;
    await runMcpServer({
      boardsRoot,
      initialBoard,
      port,
      agentIdentity: { actor, name: agentName, color: agentColor },
    });
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
