/**
 * `board add <子命令> ...` — 添加元素。
 *
 * 规格 §2.2。M1 仅实现 `add text`：
 *   `board add text <路径> "<markdown内容>"`
 * 其余子命令（file/folder）保留为占位。
 */
import { loadBoard, saveBoard } from '@board/core/node';
import { createTextElement, nextZ, defaultSizeFor } from '@board/core';
import type { ParsedArgs } from '../util/args.js';
import { CliError, EXIT, type CmdResult } from '../util/io.js';
import { resolveBoardDir } from '../util/board.js';

/** 自动错开布局的步进量（避免新文本元素完全重叠）。 */
const AUTO_PLACE_STEP = 40;

/** M1 默认参与者 id —— 无 `--actor` 时归属于此。 */
const DEFAULT_ACTOR = 'u_local';

/**
 * `board add text <路径> "<markdown内容>"`
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
 * 执行 add 命令。
 *
 * @param args 位置参数[0] = 子命令（text/file/folder）；其余按子命令解析
 */
export async function cmdAdd(args: ParsedArgs): Promise<CmdResult> {
  const sub = args.positionals[0];
  if (sub === undefined) {
    throw new CliError(
      '缺少子命令。用法: board add text <路径> "<markdown内容>"',
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
    case 'folder':
      throw new CliError(
        `子命令 "add ${sub}" 尚未实现（M2 阶段）。`,
        EXIT.GENERAL,
      );
    default:
      throw new CliError(
        `未知子命令 "add ${sub}"。可用: text`,
        EXIT.USAGE,
      );
  }
}
