/**
 * `board info <路径>` — 白板元信息与统计。
 *
 * 规格 §2.1：白板元信息与统计（id / 名称 / 元素数 / 文件数 ...）。
 */
import { listBoardFiles } from '@board/core/node';
import { regionsOf } from '@board/core';
import type { ParsedArgs } from '../util/args.js';
import { EXIT, type CmdResult } from '../util/io.js';
import { resolveBoardDir } from '../util/board.js';
import { readBoard } from '../util/board-io.js';

/**
 * 执行 info 命令。
 *
 * @param args 位置参数[0] = 白板路径（可省略，回退 --board / 向上查找）
 */
export async function cmdInfo(args: ParsedArgs): Promise<CmdResult> {
  const dir = resolveBoardDir(args.positionals[0], args.options.get('board'));
  const { meta, scene } = await readBoard(dir);
  const files = await listBoardFiles(dir);
  const regions = regionsOf(scene.elements);

  const data = {
    id: meta.id,
    name: meta.name,
    elements: scene.elements.length,
    regions: regions.length,
    files: files.length,
    participants: meta.participants.length,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  };

  const text = [
    `白板:    ${data.name}`,
    `id:      ${data.id}`,
    `元素数:  ${data.elements}`,
    `区域数:  ${data.regions}`,
    `文件数:  ${data.files}`,
    `参与者:  ${data.participants}`,
    `创建于:  ${data.createdAt}`,
    `更新于:  ${data.updatedAt}`,
  ].join('\n');

  return { code: EXIT.OK, text, data };
}
