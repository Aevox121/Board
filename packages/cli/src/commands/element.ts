/**
 * `board element <子命令> ...` — 元素级写操作（非画布全局）。
 *
 * 规格 §2 / PRD §7.2：
 *   `board element move <白板> <元素id> --to "x,y" [--size "w,h"]`
 *     —— 按画布坐标重新摆位元素（可选改尺寸），与 Web 端拖拽 / 缩放等价。
 *
 * 注意区分：
 *  - `board mv` 改的是 files/ 内的真实文件路径（=改文件元素的归属 region）
 *  - `board element move` 改的是元素在画布上的 (x, y) / (w, h)
 *
 * 不支持移动 `connector` —— 其位置由两端点的 elementId 派生，
 * 自动跟随被连元素，不可独立摆位（PRD §6.x 连线模型）。
 */
import type { Element } from '@board/core';
import type { ParsedArgs } from '../util/args.js';
import { CliError, EXIT, type CmdResult } from '../util/io.js';
import { resolveBoardDir } from '../util/board.js';
import { openBoard } from '../util/board-io.js';
import { resolveActor, buildAgentActivity } from '../util/actor.js';

/** 解析形如 "x,y" 或 "w,h" 的坐标串，失败抛 USAGE 错。 */
function parsePair(raw: string, label: string): [number, number] {
  const parts = raw.split(',').map((s) => Number(s.trim()));
  if (
    parts.length !== 2 ||
    !Number.isFinite(parts[0]) ||
    !Number.isFinite(parts[1])
  ) {
    throw new CliError(
      `${label} 必须形如 "x,y"（两个数字），收到: ${raw}`,
      EXIT.USAGE,
    );
  }
  return [parts[0]!, parts[1]!];
}

/** `board element move <白板> <元素id> --to "x,y" [--size "w,h"]` */
async function elementMove(args: ParsedArgs): Promise<CmdResult> {
  const boardPath = args.positionals[1];
  const elementId = args.positionals[2];
  const usage =
    'board element move <白板路径> <元素id> --to "x,y" [--size "w,h"]';
  if (boardPath === undefined || elementId === undefined) {
    throw new CliError(`用法: ${usage}`, EXIT.USAGE);
  }
  const toRaw = args.options.get('to');
  if (!toRaw) {
    throw new CliError(`缺少 --to。用法: ${usage}`, EXIT.USAGE);
  }
  const [x, y] = parsePair(toRaw, '--to');
  const sizeRaw = args.options.get('size');
  const size = sizeRaw ? parsePair(sizeRaw, '--size') : null;
  if (size && (size[0] <= 0 || size[1] <= 0)) {
    throw new CliError('--size 的 w / h 必须为正数', EXIT.USAGE);
  }

  const dir = resolveBoardDir(boardPath, args.options.get('board'));
  const handle = await openBoard(dir);
  const target = handle.scene.elements.find((e) => e.id === elementId);
  if (!target) {
    throw new CliError(`未找到元素：${elementId}`, EXIT.NOT_FOUND);
  }
  if (target.type === 'connector') {
    throw new CliError(
      '不能直接移动 connector —— 连线位置由两端点派生，请移动其端点元素',
      EXIT.CONFLICT,
    );
  }

  const actor = resolveActor(args);
  const ts = new Date().toISOString();
  const next = handle.scene.elements.map((e): Element => {
    if (e.id !== elementId) return e;
    const moved = {
      ...e,
      x,
      y,
      autoPlaced: false, // 手动定位后 grow-regions / auto-layout 不再触动它
      updatedBy: actor,
      updatedAt: ts,
    };
    if (size) {
      moved.width = size[0];
      moved.height = size[1];
    }
    return moved;
  });
  await handle.save({ ...handle.scene, elements: next });
  await handle.announceAgent(buildAgentActivity(args, actor, elementId));

  return {
    code: EXIT.OK,
    text:
      `已移动元素 ${elementId} → (${x}, ${y})` +
      (size ? `，尺寸 ${size[0]}×${size[1]}` : ''),
    data: {
      elementId,
      x,
      y,
      ...(size ? { width: size[0], height: size[1] } : {}),
    },
  };
}

/** `board element <子命令>` 路由。 */
export async function cmdElement(args: ParsedArgs): Promise<CmdResult> {
  const sub = args.positionals[0];
  if (sub === undefined) {
    throw new CliError(
      '用法: board element <子命令>。可用: move',
      EXIT.USAGE,
    );
  }
  switch (sub) {
    case 'move':
      return elementMove(args);
    default:
      throw new CliError(
        `未知子命令 "element ${sub}"。可用: move`,
        EXIT.USAGE,
      );
  }
}
