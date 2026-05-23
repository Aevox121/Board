/**
 * `board import <zip 路径> [--name <白板名>] [--dir <父目录>]` —— 从 zip 恢复白板。
 *
 * 从 `board export --zip` 产生的压缩包恢复一个 .board 目录。
 *
 * 行为:
 *  - 校验 zip 根含 board.json + meta.json；否则按非法包拒绝。
 *  - 目标路径 = `<--dir 父>/<--name>.board`（默认 cwd / meta.name）。
 *  - 目标已存在时拒绝覆盖（避免误删用户数据；改 --name 或先移走原目录）。
 *  - 保留原 meta.id 与 shareToken —— 用户/Agent 想要新 id 自行编辑 meta.json。
 */
import { promises as fs } from 'node:fs';
import { resolve as resolvePath, join } from 'node:path';
import JSZip from 'jszip';
import type { ParsedArgs } from '../util/args.js';
import { CliError, EXIT, type CmdResult } from '../util/io.js';

export async function cmdImport(args: ParsedArgs): Promise<CmdResult> {
  const zipPath = args.positionals[0];
  if (zipPath === undefined) {
    throw new CliError(
      '用法: board import <zip 路径> [--name <白板名>] [--dir <父目录>]',
      EXIT.USAGE,
    );
  }
  const zipAbs = resolvePath(process.cwd(), zipPath);
  let buf: Buffer;
  try {
    buf = await fs.readFile(zipAbs);
  } catch (e) {
    throw new CliError(
      `读 zip 失败：${e instanceof Error ? e.message : String(e)}`,
      EXIT.NOT_FOUND,
    );
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch (e) {
    throw new CliError(
      `解析 zip 失败：${e instanceof Error ? e.message : String(e)}`,
      EXIT.USAGE,
    );
  }
  const metaEntry = zip.file('meta.json');
  const boardEntry = zip.file('board.json');
  if (!metaEntry || !boardEntry) {
    throw new CliError(
      'zip 不是有效的白板包：根目录缺 meta.json / board.json。',
      EXIT.USAGE,
    );
  }
  let meta: { name?: string };
  try {
    meta = JSON.parse(await metaEntry.async('string'));
  } catch (e) {
    throw new CliError(
      `meta.json 解析失败：${e instanceof Error ? e.message : String(e)}`,
      EXIT.USAGE,
    );
  }
  const inferredName =
    (typeof meta.name === 'string' && meta.name.trim()) || 'imported';
  const name = args.options.get('name') ?? inferredName;
  // 防注入 / 路径逃逸 —— 白板名不允许含路径分隔符或 ..
  if (/[\\/]/.test(name) || name === '..' || name === '.') {
    throw new CliError(`非法白板名: ${name}`, EXIT.USAGE);
  }
  const dirOpt = args.options.get('dir');
  const parentDir =
    dirOpt !== undefined ? resolvePath(process.cwd(), dirOpt) : process.cwd();
  const target = join(parentDir, `${name}.board`);

  // 目标已存在 —— 拒绝覆盖。
  const exists = await fs
    .access(target)
    .then(() => true)
    .catch(() => false);
  if (exists) {
    throw new CliError(
      `目标已存在: ${target}（请改 --name 或先移走原目录）。`,
      EXIT.CONFLICT,
    );
  }

  await fs.mkdir(target, { recursive: true });
  let fileCount = 0;
  for (const [path, entry] of Object.entries(zip.files)) {
    // zip 路径不允许 .. 逃逸 —— jszip 已规范化，再加一层保险。
    if (path.includes('..')) continue;
    const out = join(target, path);
    if (entry.dir) {
      await fs.mkdir(out, { recursive: true });
      continue;
    }
    const content = await entry.async('nodebuffer');
    await fs.mkdir(join(out, '..'), { recursive: true });
    await fs.writeFile(out, content);
    fileCount++;
  }

  return {
    code: EXIT.OK,
    text: `已导入到 ${target}（${fileCount} 个文件）\n白板: ${meta.name ?? name}`,
    data: { target, name, files: fileCount },
  };
}
