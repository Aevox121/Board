/**
 * `board add <子命令> ...` — 添加元素。
 *
 * 规格 §2.2：
 *   `board add text <白板路径> "<markdown内容>"`
 *   `board add file <白板路径> <本地文件> [--region <区域名>]`
 *   `board add folder <白板路径> <本地目录> [--region <区域名>]`
 */
import { cp, copyFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import {
  loadBoard,
  saveBoard,
  listBoardFiles,
  type BoardHandle,
} from '@board/core/node';
import {
  createTextElement,
  nextZ,
  defaultSizeFor,
  regionsOf,
  reconcileFiles,
} from '@board/core';
import type { ParsedArgs } from '../util/args.js';
import { CliError, EXIT, type CmdResult } from '../util/io.js';
import { resolveBoardDir } from '../util/board.js';

/** 自动错开布局的步进量（避免新文本元素完全重叠）。 */
const AUTO_PLACE_STEP = 40;

/** M1/M2 默认参与者 id —— 无 `--actor` 时归属于此。 */
const DEFAULT_ACTOR = 'u_local';

/**
 * `board add text <白板路径> "<markdown内容>"`
 *
 * 用工厂建文本元素（autoPlaced:true），位置在已有元素基础上简单错开，
 * 推入 scene.elements 后落盘。
 */
async function addText(args: ParsedArgs): Promise<CmdResult> {
  // 位置参数：[0]=白板路径，[1]=markdown 内容
  const boardPath = args.positionals[0];
  const markdown = args.positionals[1];
  if (boardPath === undefined) {
    throw new CliError(
      '缺少白板路径。用法: board add text <路径> "<markdown内容>"',
      EXIT.USAGE,
    );
  }
  if (markdown === undefined) {
    throw new CliError(
      '缺少 markdown 内容。用法: board add text <路径> "<markdown内容>"',
      EXIT.USAGE,
    );
  }

  const dir = resolveBoardDir(boardPath, args.options.get('board'));
  const handle = await loadBoard(dir);
  const { scene } = handle;

  const size = defaultSizeFor('text');
  const z = nextZ(scene.elements);
  // 简单错开：按现有元素数量阶梯式偏移
  const offset = scene.elements.length * AUTO_PLACE_STEP;
  const actor = args.options.get('actor') ?? DEFAULT_ACTOR;

  const element = createTextElement({
    x: offset,
    y: offset,
    width: size.width,
    height: size.height,
    createdBy: actor,
    z,
    autoPlaced: true,
    markdown,
  });

  scene.elements.push(element);
  await saveBoard(dir, handle.meta, scene);

  return {
    code: EXIT.OK,
    text: `已添加文本元素 ${element.id}  (z: ${element.z}, at: ${element.x},${element.y})`,
    data: {
      elementId: element.id,
      type: element.type,
      x: element.x,
      y: element.y,
      z: element.z,
    },
  };
}

/**
 * 校验并解析 `--region` 选项，返回区域在 files/ 下的相对路径段（无区域则为空串）。
 *
 * 指定 `--region` 时，要求白板内已存在同名 region 元素，否则报错。
 */
function resolveRegionSegment(
  regionOpt: string | undefined,
  handle: BoardHandle,
): string {
  if (regionOpt === undefined) return '';
  const name = regionOpt.trim();
  if (name === '') {
    throw new CliError('--region 区域名不能为空。', EXIT.USAGE);
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new CliError(
      `--region 区域名不能包含路径分隔符或 ".."：${name}`,
      EXIT.USAGE,
    );
  }
  const exists = regionsOf(handle.scene.elements).some((r) => r.path === name);
  if (!exists) {
    throw new CliError(
      `区域不存在: ${name}（先用 board region create 创建）`,
      EXIT.NOT_FOUND,
    );
  }
  return name;
}

/**
 * 把本地内容复制进 files/（或 files/<区域名>/）后，
 * 用 reconcileFiles 同步 file 元素并落盘。
 *
 * @param kind 'file' | 'folder'，仅用于错误提示文案
 */
async function addLocal(
  args: ParsedArgs,
  kind: 'file' | 'folder',
): Promise<CmdResult> {
  const usage =
    kind === 'file'
      ? 'board add file <白板路径> <本地文件> [--region <区域名>]'
      : 'board add folder <白板路径> <本地目录> [--region <区域名>]';

  // 位置参数：[0]=白板路径，[1]=本地文件/目录
  const boardPath = args.positionals[0];
  const localPath = args.positionals[1];
  if (boardPath === undefined) {
    throw new CliError(`缺少白板路径。用法: ${usage}`, EXIT.USAGE);
  }
  if (localPath === undefined) {
    throw new CliError(
      `缺少本地${kind === 'file' ? '文件' : '目录'}。用法: ${usage}`,
      EXIT.USAGE,
    );
  }

  const dir = resolveBoardDir(boardPath, args.options.get('board'));
  const handle = await loadBoard(dir);

  // 解析本地源路径并校验类型
  const srcAbs = isAbsolute(localPath)
    ? localPath
    : resolve(process.cwd(), localPath);
  if (!existsSync(srcAbs)) {
    throw new CliError(`本地路径不存在: ${localPath}`, EXIT.NOT_FOUND);
  }
  const srcStat = await stat(srcAbs);
  if (kind === 'file' && !srcStat.isFile()) {
    throw new CliError(`不是文件: ${localPath}`, EXIT.USAGE);
  }
  if (kind === 'folder' && !srcStat.isDirectory()) {
    throw new CliError(`不是目录: ${localPath}`, EXIT.USAGE);
  }

  // 解析目标区域段
  const regionSeg = resolveRegionSegment(args.options.get('region'), handle);
  const name = basename(srcAbs);
  const destDir =
    regionSeg === ''
      ? join(dir, 'files')
      : join(dir, 'files', regionSeg);
  const destAbs = join(destDir, name);

  if (existsSync(destAbs)) {
    throw new CliError(
      `目标已存在: files/${regionSeg === '' ? '' : regionSeg + '/'}${name}`,
      EXIT.CONFLICT,
    );
  }

  // 复制进 files/
  await mkdir(destDir, { recursive: true });
  if (kind === 'file') {
    await copyFile(srcAbs, destAbs);
  } else {
    await cp(srcAbs, destAbs, { recursive: true });
  }

  // 扫描 files/ 并 reconcile，使 board.json 出现新增 file 元素
  const diskFiles = await listBoardFiles(dir);
  const actor = args.options.get('actor') ?? DEFAULT_ACTOR;
  const result = reconcileFiles({
    scene: handle.scene,
    diskFiles,
    actor,
  });
  await saveBoard(dir, handle.meta, result.scene);

  const destRel = regionSeg === '' ? name : `${regionSeg}/${name}`;
  return {
    code: EXIT.OK,
    text:
      kind === 'file'
        ? `已添加文件 files/${destRel}  (新增 ${result.added.length} 个 file 元素)`
        : `已添加目录 files/${destRel}/  (新增 ${result.added.length} 个 file 元素)`,
    data: {
      dest: destRel,
      region: regionSeg === '' ? null : regionSeg,
      added: result.added,
      removed: result.removed,
    },
  };
}

/**
 * 执行 add 命令。
 *
 * @param args 位置参数[0] = 子命令（text/file/folder）；其余按子命令解析
 */
export async function cmdAdd(args: ParsedArgs): Promise<CmdResult> {
  const sub = args.positionals[0];
  if (sub === undefined) {
    throw new CliError(
      '缺少子命令。用法: board add text|file|folder <白板路径> ...',
      EXIT.USAGE,
    );
  }

  // 子命令吃掉首个位置参数，其余下移
  const subArgs: ParsedArgs = {
    positionals: args.positionals.slice(1),
    flags: args.flags,
    options: args.options,
  };

  switch (sub) {
    case 'text':
      return addText(subArgs);
    case 'file':
      return addLocal(subArgs, 'file');
    case 'folder':
      return addLocal(subArgs, 'folder');
    default:
      throw new CliError(
        `未知子命令 "add ${sub}"。可用: text, file, folder`,
        EXIT.USAGE,
      );
  }
}
