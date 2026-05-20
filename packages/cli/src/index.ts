#!/usr/bin/env node
/**
 * board CLI（骨架）
 *
 * 命令清单与参数见 specs/CLI与MCP规格.md §2。
 * 当前阶段仅做命令路由与占位，逐里程碑补全各命令实现。
 *
 * 退出码（规格 §1.4）：0 成功 / 1 一般错误 / 2 参数错误
 *                     / 3 未找到 / 4 冲突 / 5 权限不足
 */

/** 已登记的顶层命令。 */
const COMMANDS = [
  'new', 'open', 'serve', 'ls', 'info',
  'add', 'region', 'shape', 'connect', 'rm', 'mv',
  'show', 'tree', 'search',
  'suggest', 'task', 'comment', 'agent', 'watch',
  'snapshot', 'restore', 'export', 'import', 'share', 'sync',
] as const;

type Command = (typeof COMMANDS)[number];

function isCommand(s: string): s is Command {
  return (COMMANDS as readonly string[]).includes(s);
}

function printHelp(): void {
  console.log('board <命令> [参数]');
  console.log('全局选项: --board <path>  --json  --quiet  --actor <id>');
  console.log('命令: ' + COMMANDS.join(', '));
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === '--help' || cmd === '-h') {
    printHelp();
    return 0;
  }
  if (!isCommand(cmd)) {
    console.error(`未知命令: ${cmd}（board --help 查看可用命令）`);
    return 2;
  }

  // TODO(M2): 实现 new/open/serve/ls/info/add/region/rm/mv/show/tree/search
  // TODO(M2): 绘图命令 shape/connect
  // TODO(M3): suggest/task/comment/agent/watch
  // TODO(M4): snapshot/restore/share/sync
  console.error(`命令 "${cmd}" 尚未实现（骨架阶段）。参数: ${JSON.stringify(rest)}`);
  return 1;
}

process.exit(main(process.argv.slice(2)));
