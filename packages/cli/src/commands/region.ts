/**
 * `board region <子命令> ...` — 区域操作。
 *
 * 规格 §2.2：
 *   `board region create <白板路径> <区域名> [--desc "<描述>"]`
 *   `board region ls <白板路径>`
 *
 * 区域本质是 files/ 下的一个文件夹（规格 R1）：
 *   - 在磁盘建 `files/<区域名>/` 目录；
 *   - 区域描述落地为该文件夹的 `README.md`；
 *   - 场景里建一个 region 元素，path 指向该文件夹相对路径。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadBoard, saveBoard } from '@board/core/node';
import {
  createRegionElement,
  nextZ,
  defaultSizeFor,
  regionsOf,
  INBOX_RECT,
} from '@board/core';
import type { ParsedArgs } from '../util/args.js';
import { CliError, EXIT, type CmdResult } from '../util/io.js';
import { resolveBoardDir } from '../util/board.js';

/** 区域横向平铺时的间隙。 */
const REGION_GAP = 56;

/** M2 默认参与者 id —— 无 `--actor` 时归属于此。 */
const DEFAULT_ACTOR = 'u_local';

/**
 * 校验区域名：不允许为空、不允许带路径分隔符或 `..`。
 * 区域名直接作为 files/ 下的文件夹名。
 */
function validateRegionName(name: string): void {
  if (name.trim() === '') {
    throw new CliError('区域名不能为空。', EXIT.USAGE);
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new CliError(
      `区域名不能包含路径分隔符或 ".."：${name}`,
      EXIT.USAGE,
    );
  }
}

/**
 * `board region create <白板路径> <区域名> [--desc "<描述>"]`
 *
 * 建 `files/<区域名>/` 文件夹 + 写 README.md（内容为描述），
 * 用工厂建 region 元素（autoPlaced:true）推入场景后落盘。
 */
async function regionCreate(args: ParsedArgs): Promise<CmdResult> {
  // 位置参数：[0]=白板路径，[1]=区域名
  const boardPath = args.positionals[0];
  const regionName = args.positionals[1];
  if (boardPath === undefined) {
    throw new CliError(
      '缺少白板路径。用法: board region create <白板路径> <区域名> [--desc "<描述>"]',
      EXIT.USAGE,
    );
  }
  if (regionName === undefined) {
    throw new CliError(
      '缺少区域名。用法: board region create <白板路径> <区域名> [--desc "<描述>"]',
      EXIT.USAGE,
    );
  }
  validateRegionName(regionName);

  const dir = resolveBoardDir(boardPath, args.options.get('board'));
  const handle = await loadBoard(dir);
  const { scene } = handle;

  // 区域重名检查（规格 §1.4 退出码 4）
  const existing = regionsOf(scene.elements);
  if (existing.some((r) => r.path === regionName)) {
    throw new CliError(`区域已存在: ${regionName}`, EXIT.CONFLICT);
  }

  // 1. 在磁盘建文件夹 + 写 README.md
  const regionDir = join(dir, 'files', regionName);
  if (existsSync(regionDir)) {
    throw new CliError(
      `目标文件夹已存在: files/${regionName}`,
      EXIT.CONFLICT,
    );
  }
  await mkdir(regionDir, { recursive: true });
  const description = args.options.get('desc') ?? '';
  await writeFile(join(regionDir, 'README.md'), description, 'utf8');

  // 2. 建 region 元素并推入场景
  const size = defaultSizeFor('region');
  const z = nextZ(scene.elements);
  // 区域横向平铺、互不重叠；整体置于收件区下方，避开游离文件。
  const x = existing.length * (size.width + REGION_GAP);
  const y = INBOX_RECT.y + INBOX_RECT.height + REGION_GAP;
  const actor = args.options.get('actor') ?? DEFAULT_ACTOR;

  const element = createRegionElement({
    x,
    y,
    width: size.width,
    height: size.height,
    createdBy: actor,
    z,
    autoPlaced: true,
    path: regionName,
    label: regionName,
    description,
  });

  scene.elements.push(element);
  await saveBoard(dir, handle.meta, scene);

  return {
    code: EXIT.OK,
    text: `已创建区域 "${regionName}"  (元素 ${element.id}, 文件夹 files/${regionName}/)`,
    data: {
      elementId: element.id,
      label: element.label,
      path: element.path,
      description: element.description,
      x: element.x,
      y: element.y,
      z: element.z,
    },
  };
}

/**
 * `board region ls <白板路径>`
 *
 * 列出白板内所有 region 元素：名称 + 描述 + 路径。
 */
async function regionLs(args: ParsedArgs): Promise<CmdResult> {
  const dir = resolveBoardDir(args.positionals[0], args.options.get('board'));
  const handle = await loadBoard(dir);
  const regions = regionsOf(handle.scene.elements);

  const list = regions.map((r) => ({
    elementId: r.id,
    label: r.label,
    description: r.description,
    path: `files/${r.path}/`,
  }));

  const text =
    list.length === 0
      ? '白板内暂无区域。'
      : list
          .map((r) => {
            const desc = r.description.trim() === '' ? '（无描述）' : r.description;
            return `${r.label}\n  描述: ${desc}\n  路径: ${r.path}`;
          })
          .join('\n');

  return { code: EXIT.OK, text, data: { regions: list } };
}

/**
 * 执行 region 命令。
 *
 * @param args 位置参数[0] = 子命令（create/ls）；其余按子命令解析
 */
export async function cmdRegion(args: ParsedArgs): Promise<CmdResult> {
  const sub = args.positionals[0];
  if (sub === undefined) {
    throw new CliError(
      '缺少子命令。用法: board region create|ls <白板路径> ...',
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
    case 'create':
      return regionCreate(subArgs);
    case 'ls':
      return regionLs(subArgs);
    default:
      throw new CliError(
        `未知子命令 "region ${sub}"。可用: create, ls`,
        EXIT.USAGE,
      );
  }
}
