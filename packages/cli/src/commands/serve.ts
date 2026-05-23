/**
 * `board serve <路径1> [<路径2> ...] [--port <n>] [--host <addr>]` —— 起 board-server。
 *
 * 让 Agent 一句命令把本地 server 跑起来 —— 而无需了解 monorepo 的 pnpm /
 * tsx 细节。等价于 `BOARD_PORT=… BOARD_HOST=… tsx packages/server/src/index.ts
 * <dir1> <dir2>`，但携带路径校验 + 信号转发。
 *
 *  - 多 .board 直接列在位置参数（中继模式，PRD §4.2）。
 *  - `--port` / `--host` 写入子进程环境（与 server/index.ts 的 BOARD_PORT /
 *    BOARD_HOST 对齐）。
 *  - 进程阻塞至子进程退出；SIGINT / SIGTERM 转发给子进程。
 *
 * `board open` 在 MVP 不实现 —— Agent 没浏览器；人若要看可以 serve 之后自己
 * 打开 web 即可。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ParsedArgs } from '../util/args.js';
import { CliError, EXIT, type CmdResult } from '../util/io.js';
import { resolveBoardDir } from '../util/board.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * 找 board-server 入口 —— 优先 dist（生产 / build 后），fallback src（tsx 开发）。
 * monorepo 内 cli 与 server 平级，路径相对 dist/commands 或 src/commands。
 */
function findServerEntry(): { entry: string; runtime: 'node' | 'tsx' } {
  const candidates: Array<{ rel: string; runtime: 'node' | 'tsx' }> = [
    { rel: '../../../server/dist/index.js', runtime: 'node' },
    { rel: '../../../server/src/index.ts', runtime: 'tsx' },
  ];
  for (const c of candidates) {
    const full = resolvePath(SCRIPT_DIR, c.rel);
    if (existsSync(full)) return { entry: full, runtime: c.runtime };
  }
  throw new CliError(
    'board-server 入口找不到：先 pnpm -r build，或确保在 monorepo 源码内。',
    EXIT.NOT_FOUND,
  );
}

export async function cmdServe(args: ParsedArgs): Promise<CmdResult> {
  if (args.positionals.length === 0) {
    throw new CliError(
      '用法: board serve <.board 路径> [<.board 路径> ...] [--port <n>] [--host <addr>]',
      EXIT.USAGE,
    );
  }
  // 全部路径必须是有效 .board（先校验，不让 server 起一半再炸）。
  const dirs = args.positionals.map((p) =>
    resolveBoardDir(p, args.options.get('board')),
  );

  const env: NodeJS.ProcessEnv = { ...process.env };
  const port = args.options.get('port');
  const host = args.options.get('host');
  if (port) env['BOARD_PORT'] = port;
  if (host) env['BOARD_HOST'] = host;

  const { entry, runtime } = findServerEntry();
  // tsx / node 都通过 child_process spawn；shell: true 让 Windows 能找到
  // node_modules/.bin/tsx（PATH 解析）。
  const cmd = runtime === 'tsx' ? 'tsx' : 'node';
  const child = spawn(cmd, [entry, ...dirs], {
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  const forwardSig = (sig: NodeJS.Signals): void => {
    if (!child.killed) child.kill(sig);
  };
  process.on('SIGINT', () => forwardSig('SIGINT'));
  process.on('SIGTERM', () => forwardSig('SIGTERM'));

  return new Promise<CmdResult>((resolve, reject) => {
    child.on('error', (e) => {
      reject(
        new CliError(
          `启动 board-server 失败：${e.message}`,
          EXIT.GENERAL,
        ),
      );
    });
    child.on('exit', (code) => {
      resolve({ code: code ?? 0 });
    });
  });
}
