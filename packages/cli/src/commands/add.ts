/**
 * `board add <子命令> ...` — 添加元素。
 *
 * 规格 §2.2：
 *   `board add text <白板路径> "<markdown内容>"`
 *   `board add file <白板路径> <本地文件> [--region <区域名>]`
 *   `board add folder <白板路径> <本地目录> [--region <区域名>]`
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, isAbsolute, join, resolve, relative, sep } from 'node:path';
import {
  createTextElement,
  nextZ,
  defaultSizeFor,
  measureLabelHeight,
  DEFAULT_STYLE,
  regionsOf,
  INBOX_RECT,
} from '@board/core';
import type { ParsedArgs } from '../util/args.js';
import { CliError, EXIT, type CmdResult } from '../util/io.js';
import { resolveBoardDir } from '../util/board.js';
import { openBoard, type BoardSession } from '../util/board-io.js';
import { resolveActor, buildAgentActivity } from '../util/actor.js';
import { autoPlace, autoPlaceNear } from '../util/layout.js';

/** 解析 `--at "x,y"` → `[x,y]`；缺省 / 非法返回 null。 */
function parseAtOption(raw: string | undefined): [number, number] | null {
  if (!raw) return null;
  const parts = raw.split(',').map((s) => Number(s.trim()));
  const a = parts[0];
  const b = parts[1];
  if (
    parts.length === 2 &&
    a !== undefined &&
    b !== undefined &&
    Number.isFinite(a) &&
    Number.isFinite(b)
  ) {
    return [a, b];
  }
  return null;
}

/**
 * 解析 `--size "w"` 或 `"w,h"` → {width, height?}；非法 / 缺省返回 null。
 * 文本卡只需控制**宽度**（决定折行进而决定高度）；高度可选，web 端仍会按
 * 实际渲染自适应修正，这里给的高度只作初值。
 */
function parseSizeOption(
  raw: string | undefined,
): { width: number; height: number | null } | null {
  if (!raw) return null;
  const parts = raw.split(',').map((s) => Number(s.trim()));
  const w = parts[0];
  if (w === undefined || !Number.isFinite(w) || w <= 0) return null;
  const h = parts[1];
  const height = h !== undefined && Number.isFinite(h) && h > 0 ? h : null;
  return { width: w, height };
}

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
  const handle = await openBoard(dir);
  const { scene } = handle;

  // 尺寸：--size 控制宽度（窄卡装长文 / heading 会被撑很高，故开放宽度）；
  // 高度按 markdown 在该宽度下折行估个初值（L1 measureLabelHeight），用户显式
  // 给 h 时取 max。web 端 ResizeObserver 会按实际渲染精修高度，这里只为减少跳动。
  const sizeOpt = parseSizeOption(args.options.get('size'));
  const defSize = defaultSizeFor('text');
  const width = sizeOpt ? sizeOpt.width : defSize.width;
  let height = sizeOpt?.height ?? defSize.height;
  if (markdown) {
    height = Math.max(
      height,
      measureLabelHeight(markdown, width, DEFAULT_STYLE.fontSize),
    );
  }
  const size = { width, height };
  const z = nextZ(scene.elements);
  const actor = resolveActor(args);

  // 摆放（M5 L2 仲裁）：
  //  --force-at "x,y" → 硬坐标，跳过避让（Agent 自负不重叠）；
  //  --at "x,y"       → 锚点偏好，被占则网格行优先外扩到最近空位（不堆叠）；
  //  都不给           → 收件区自动落位。
  const forceAt = parseAtOption(args.options.get('force-at'));
  const at = parseAtOption(args.options.get('at'));
  let x: number;
  let y: number;
  let nudged = false;
  if (forceAt) {
    [x, y] = forceAt;
  } else if (at) {
    const pos = autoPlaceNear(scene.elements, null, { x: at[0], y: at[1] }, size);
    x = pos.x;
    y = pos.y;
    nudged = pos.nudged;
  } else {
    const pos = autoPlace(scene.elements, null, INBOX_RECT, size);
    x = pos.x;
    y = pos.y;
  }

  const element = createTextElement({
    x,
    y,
    width: size.width,
    height: size.height,
    createdBy: actor,
    z,
    // forceAt / at 都是用户位置意图 → 不参与后续自动重排；仅纯自动落位标 autoPlaced。
    autoPlaced: forceAt === null && at === null,
    markdown,
  });
  // --draft：标记为 draft 态 —— Pencil 式过程可视化中 Agent 进行中的产出
  // （半透明虚线渲染），task.finish 时统一转 committed（PRD §7.4）。
  if (args.flags.has('draft')) {
    element.state = 'draft';
  }

  scene.elements.push(element);
  await handle.save(scene);
  await handle.announceAgent(buildAgentActivity(args, actor, element.id));

  return {
    code: EXIT.OK,
    text: `已添加文本元素 ${element.id}  (z: ${element.z}, at: ${element.x},${element.y})${nudged ? ' [已避让]' : ''}`,
    data: {
      elementId: element.id,
      type: element.type,
      x: element.x,
      y: element.y,
      z: element.z,
      placedAt: { x: element.x, y: element.y },
      nudged,
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
  handle: BoardSession,
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
  const handle = await openBoard(dir);

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

  // 解析目标区域段(基于当前 server 视图)
  const regionSeg = resolveRegionSegment(args.options.get('region'), handle);
  const name = basename(srcAbs);

  const actor = resolveActor(args);

  // 单文件:读字节直传 server,server 写盘 + reconcileNow 建 file 元素。
  // 多文件目录:递归 walk + 逐文件直传。server 每次 upload 都 reconcile,
  // 大目录会偏慢但 MVP 范围内可接受。
  const uploaded: string[] = [];
  if (kind === 'file') {
    const destRel = regionSeg === '' ? name : `${regionSeg}/${name}`;
    const buf = await readFile(srcAbs);
    await handle.server.uploadFile(destRel, buf);
    uploaded.push(destRel);
  } else {
    // 递归 walk srcAbs 下所有文件,目录名作为 path 前缀(srcAbs basename 包进去)
    async function walk(absDir: string): Promise<void> {
      const entries = await readdir(absDir, { withFileTypes: true });
      for (const e of entries) {
        const full = join(absDir, e.name);
        if (e.isDirectory()) {
          await walk(full);
        } else if (e.isFile()) {
          // 相对 srcAbs 的父目录,得到 "<folder>/sub/file.ext"
          const rel = relative(srcAbs + sep + '..', full).split(sep).join('/');
          const dest = regionSeg === '' ? rel : `${regionSeg}/${rel}`;
          const buf = await readFile(full);
          await handle.server.uploadFile(dest, buf);
          uploaded.push(dest);
        }
      }
    }
    await walk(srcAbs);
  }

  // server 已 reconcile,重新拉一次 scene 找出新加的 file 元素(用于 announceAgent)
  const { scene: nextScene } = await handle.server.fetchBoard();
  const firstAdded = nextScene.elements.find(
    (e) => e.type === 'file' && uploaded.includes(e.path ?? ''),
  );
  await handle.announceAgent(
    buildAgentActivity(args, actor, firstAdded?.id),
  );

  const destRel = regionSeg === '' ? name : `${regionSeg}/${name}`;
  return {
    code: EXIT.OK,
    text:
      kind === 'file'
        ? `已添加文件 files/${destRel}`
        : `已添加目录 files/${destRel}/  (上传 ${uploaded.length} 个文件)`,
    data: {
      dest: destRel,
      region: regionSeg === '' ? null : regionSeg,
      uploaded,
      elementId: firstAdded?.id ?? null,
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
