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
import { openBoard } from '../util/board-io.js';
import { resolveActor, buildAgentActivity } from '../util/actor.js';

/** 区域横向平铺时的间隙。 */
const REGION_GAP = 56;

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
  const handle = await openBoard(dir);
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
  const actor = resolveActor(args);
  // 软归属（PRD §8.3）—— `--owner me` / `<id>` / `none`，默认归属创建者。
  const ownerRaw = args.options.get('owner');
  const ownerId =
    ownerRaw === undefined
      ? actor
      : ownerRaw === 'me'
        ? actor
        : ownerRaw === 'none' || ownerRaw === ''
          ? null
          : ownerRaw;

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
    ownerId,
  });

  scene.elements.push(element);
  await handle.save(scene);
  await handle.announceAgent(buildAgentActivity(actor, element.id));

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
  const handle = await openBoard(dir);
  const regions = regionsOf(handle.scene.elements);

  // 归属显示：优先取 participants 里的 name，找不到就回退到 id；无归属 = `（公共）`。
  const partMap = new Map(handle.meta.participants.map((p) => [p.id, p.name]));
  const list = regions.map((r) => ({
    elementId: r.id,
    label: r.label,
    description: r.description,
    path: `files/${r.path}/`,
    ownerId: r.ownerId,
    ownerName: r.ownerId ? partMap.get(r.ownerId) ?? r.ownerId : null,
  }));

  const text =
    list.length === 0
      ? '白板内暂无区域。'
      : list
          .map((r) => {
            const desc = r.description.trim() === '' ? '（无描述）' : r.description;
            const owner = r.ownerName ?? '（公共）';
            return `${r.label}\n  描述: ${desc}\n  归属: ${owner}\n  路径: ${r.path}`;
          })
          .join('\n');

  return { code: EXIT.OK, text, data: { regions: list } };
}

/**
 * `board region own <白板路径> <区域名> --owner <id|me|none>`
 *
 * 改区域软归属（PRD §8.3）。`me` = 当前 actor，`none` = 取消归属（公共），
 * 其它 = 指定 participant id。仅改 `ownerId` 字段，不动其他属性。
 */
async function regionOwn(args: ParsedArgs): Promise<CmdResult> {
  const boardPath = args.positionals[0];
  const regionName = args.positionals[1];
  if (boardPath === undefined || regionName === undefined) {
    throw new CliError(
      '用法: board region own <白板路径> <区域名> --owner <id|me|none>',
      EXIT.USAGE,
    );
  }
  const ownerRaw = args.options.get('owner');
  if (ownerRaw === undefined) {
    throw new CliError(
      '缺少 --owner。用法: board region own <白板路径> <区域名> --owner <id|me|none>',
      EXIT.USAGE,
    );
  }

  const dir = resolveBoardDir(boardPath, args.options.get('board'));
  const handle = await openBoard(dir);
  const region = regionsOf(handle.scene.elements).find(
    (r) => r.label === regionName || r.path === regionName,
  );
  if (!region) {
    throw new CliError(`未找到区域：${regionName}`, EXIT.NOT_FOUND);
  }

  const actor = resolveActor(args);
  const nextOwnerId =
    ownerRaw === 'me'
      ? actor
      : ownerRaw === 'none' || ownerRaw === ''
        ? null
        : ownerRaw;

  const ts = new Date().toISOString();
  const next = handle.scene.elements.map((e) =>
    e.id === region.id && e.type === 'region'
      ? { ...e, ownerId: nextOwnerId, updatedBy: actor, updatedAt: ts }
      : e,
  );
  await handle.save({ ...handle.scene, elements: next });
  await handle.announceAgent(buildAgentActivity(actor, region.id));

  const ownerLabel =
    nextOwnerId === null
      ? '公共'
      : handle.meta.participants.find((p) => p.id === nextOwnerId)?.name ??
        nextOwnerId;
  return {
    code: EXIT.OK,
    text: `已将区域「${region.label}」归属设为：${ownerLabel}`,
    data: { elementId: region.id, label: region.label, ownerId: nextOwnerId },
  };
}

/**
 * `board region describe <白板路径> <区域名> --desc "<描述>"`
 *
 * 改区域描述，并同步落地为该区域文件夹的 README.md（规格 §2.2 / R5）。
 */
async function regionDescribe(args: ParsedArgs): Promise<CmdResult> {
  const boardPath = args.positionals[0];
  const regionName = args.positionals[1];
  if (boardPath === undefined || regionName === undefined) {
    throw new CliError(
      '用法: board region describe <白板路径> <区域名> --desc "<描述>"',
      EXIT.USAGE,
    );
  }
  const desc = args.options.get('desc');
  if (desc === undefined) {
    throw new CliError(
      '缺少 --desc。用法: board region describe <白板路径> <区域名> --desc "<描述>"',
      EXIT.USAGE,
    );
  }

  const dir = resolveBoardDir(boardPath, args.options.get('board'));
  const handle = await openBoard(dir);
  const region = regionsOf(handle.scene.elements).find(
    (r) => r.label === regionName || r.path === regionName,
  );
  if (!region) {
    throw new CliError(`未找到区域：${regionName}`, EXIT.NOT_FOUND);
  }

  const actor = resolveActor(args);
  const ts = new Date().toISOString();
  const next = handle.scene.elements.map((e) =>
    e.id === region.id && e.type === 'region'
      ? { ...e, description: desc, updatedBy: actor, updatedAt: ts }
      : e,
  );
  await handle.save({ ...handle.scene, elements: next });
  await handle.announceAgent(buildAgentActivity(actor, region.id));
  // 区域描述同步落地为文件夹 README.md。
  await writeFile(join(dir, 'files', region.path, 'README.md'), desc, 'utf8');

  return {
    code: EXIT.OK,
    text: `已更新区域「${region.label}」的描述`,
    data: { elementId: region.id, label: region.label, description: desc },
  };
}

/**
 * `board region assign <白板路径> <区域名> --agent <agentId>`
 *
 * 把区域指派给某个 Agent（PRD §7.6 区域委派）—— 设 `assignedAgentId`。
 */
async function regionAssign(args: ParsedArgs): Promise<CmdResult> {
  const boardPath = args.positionals[0];
  const regionName = args.positionals[1];
  if (boardPath === undefined || regionName === undefined) {
    throw new CliError(
      '用法: board region assign <白板路径> <区域名> --agent <agentId>',
      EXIT.USAGE,
    );
  }
  const agent = args.options.get('agent');
  if (!agent) {
    throw new CliError(
      '缺少 --agent。用法: board region assign <白板路径> <区域名> --agent <agentId>',
      EXIT.USAGE,
    );
  }

  const dir = resolveBoardDir(boardPath, args.options.get('board'));
  const handle = await openBoard(dir);
  const region = regionsOf(handle.scene.elements).find(
    (r) => r.label === regionName || r.path === regionName,
  );
  if (!region) {
    throw new CliError(`未找到区域：${regionName}`, EXIT.NOT_FOUND);
  }

  const actor = resolveActor(args);
  const ts = new Date().toISOString();
  const next = handle.scene.elements.map((e) =>
    e.id === region.id && e.type === 'region'
      ? { ...e, assignedAgentId: agent, updatedBy: actor, updatedAt: ts }
      : e,
  );
  await handle.save({ ...handle.scene, elements: next });
  await handle.announceAgent(buildAgentActivity(actor, region.id));

  return {
    code: EXIT.OK,
    text: `已把区域「${region.label}」指派给 ${agent}`,
    data: { elementId: region.id, label: region.label, assignedAgentId: agent },
  };
}

/**
 * 执行 region 命令。
 *
 * @param args 位置参数[0] = 子命令（create/ls/describe/assign）；其余按子命令解析
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
    case 'describe':
      return regionDescribe(subArgs);
    case 'assign':
      return regionAssign(subArgs);
    case 'own':
      return regionOwn(subArgs);
    default:
      throw new CliError(
        `未知子命令 "region ${sub}"。可用: create, ls, describe, assign, own`,
        EXIT.USAGE,
      );
  }
}
