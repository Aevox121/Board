/**
 * `board export <路径> [--json|--zip] [--out <文件>]` —— 导出白板。
 *
 * 让 Agent 在 CLI 拥有与 Web 顶栏对等的「打包带走」能力。MVP 实现两种格式:
 *  - `--json`(默认):把场景写为 board.json。`--out <文件>` 落盘；不给则
 *    打印到 stdout。等价于 Web 顶栏的 "导出 board.json"。
 *  - `--zip`:把整个 .board 目录(board.json + meta.json + files/ + assets/
 *    + history/...）打包为 zip。给用户「拷一份就能跑」的可移植产物
 *    (spec §2.6)。
 *
 * 未实现(spec §2.6 提及，需要 SSR 渲染白板):`--png` / `--svg` / `--html`。
 * 当前 image 类导出只在 Web 顶栏可用(依赖 DOM)；CLI 暂未提供 SSR 路径。
 * 调这些 flag 会显式报错告诉 Agent。
 */
import { promises as fs } from 'node:fs';
import { resolve as resolvePath, join, basename, relative } from 'node:path';
import JSZip from 'jszip';
import { loadBoard } from '@board/core/node';
import type { ParsedArgs } from '../util/args.js';
import { CliError, EXIT, type CmdResult } from '../util/io.js';
import { resolveBoardDir } from '../util/board.js';

/** 递归把目录加入 zip；zip 内路径用 POSIX 分隔符。 */
async function addDirToZip(
  zip: JSZip,
  rootDir: string,
  currentDir: string,
): Promise<void> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  for (const ent of entries) {
    const full = join(currentDir, ent.name);
    const rel = relative(rootDir, full).split('\\').join('/');
    if (ent.isDirectory()) {
      zip.folder(rel);
      await addDirToZip(zip, rootDir, full);
    } else if (ent.isFile()) {
      zip.file(rel, await fs.readFile(full));
    }
    // 软链接 / 设备文件等其它类型跳过。
  }
}

export async function cmdExport(args: ParsedArgs): Promise<CmdResult> {
  const boardPath = args.positionals[0];
  if (boardPath === undefined) {
    throw new CliError(
      '用法: board export <白板路径> [--json | --zip] [--out <文件>]',
      EXIT.USAGE,
    );
  }
  // spec §2.6 提及但未实现的格式 —— 显式报错而非默默忽略。
  for (const flag of ['png', 'svg', 'html'] as const) {
    if (args.flags.has(flag)) {
      throw new CliError(
        `--${flag} 导出尚未实现（依赖浏览器 DOM 渲染；spec §2.6 待补 SSR 路径）。当前 CLI 仅支持 --json / --zip。`,
        EXIT.GENERAL,
      );
    }
  }
  const wantZip = args.flags.has('zip');
  const wantJson = args.flags.has('json') || !wantZip; // 默认 = json
  if (args.flags.has('zip') && args.flags.has('json')) {
    throw new CliError('--json 和 --zip 不能同时指定。', EXIT.USAGE);
  }

  const dir = resolveBoardDir(boardPath, args.options.get('board'));
  const handle = await loadBoard(dir);
  const outOpt = args.options.get('out');

  if (wantJson) {
    // 读磁盘上的 board.json 而非序列化内存场景 —— server 已节流投影写盘，
    // 字节级一致；CLI 无 server 在跑的离线场景也只读不写。
    const src = join(dir, 'board.json');
    const data = await fs.readFile(src, 'utf8');
    if (outOpt !== undefined) {
      const out = resolvePath(process.cwd(), outOpt);
      await fs.writeFile(out, data, 'utf8');
      return {
        code: EXIT.OK,
        text: `已写 ${out}（${data.length} 字节）`,
        data: { format: 'json', out, bytes: data.length },
      };
    }
    return {
      code: EXIT.OK,
      text: data,
      data: { format: 'json', out: null, bytes: data.length },
    };
  }

  // --zip
  const defaultName = `${basename(dir).replace(/\.board$/i, '')}.board.zip`;
  const out = resolvePath(
    process.cwd(),
    outOpt !== undefined ? outOpt : defaultName,
  );
  const zip = new JSZip();
  await addDirToZip(zip, dir, dir);
  const buf = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  await fs.writeFile(out, buf);
  return {
    code: EXIT.OK,
    text: `已打包 ${out}（${buf.length} 字节）\n白板: ${handle.meta.name}`,
    data: {
      format: 'zip',
      out,
      bytes: buf.length,
      name: handle.meta.name,
    },
  };
}
