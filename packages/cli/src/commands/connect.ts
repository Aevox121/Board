/**
 * `board connect <白板路径> <源元素id> <目标元素id> ...` — 在两元素间连线。
 *
 * 规格 §2.3：board connect <源id> <目标id> [--label "<文字>"]
 *            [--arrow none|arrow|triangle|dot] [--routing straight|orthogonal|curved]
 *
 * 连线归 Excalidraw 画布层渲染。两端若都是图形（shape），Web 端会建立
 * Excalidraw 端点绑定 —— 图形移动时连线自动跟随。
 */
import {
  createConnectorElement,
  nextZ,
  type ArrowHead,
  type ConnectorRouting,
} from '@board/core';
import type { ParsedArgs } from '../util/args.js';
import { CliError, EXIT, type CmdResult } from '../util/io.js';
import { resolveBoardDir } from '../util/board.js';
import { openBoard } from '../util/board-io.js';

/** 无 `--actor`/`--agent` 时归属的默认参与者 id。 */
const DEFAULT_ACTOR = 'u_local';
const VALID_ARROWS: ReadonlySet<string> = new Set([
  'none',
  'arrow',
  'triangle',
  'dot',
]);
const VALID_ROUTING: ReadonlySet<string> = new Set([
  'straight',
  'orthogonal',
  'curved',
]);

/** 执行 connect 命令。 */
export async function cmdConnect(args: ParsedArgs): Promise<CmdResult> {
  const boardPath = args.positionals[0];
  const fromId = args.positionals[1];
  const toId = args.positionals[2];
  const usage =
    'board connect <白板路径> <源元素id> <目标元素id> [--label "<文字>"] [--arrow none|arrow|triangle|dot] [--routing straight|orthogonal|curved]';
  if (boardPath === undefined) {
    throw new CliError(`缺少白板路径。用法: ${usage}`, EXIT.USAGE);
  }
  if (fromId === undefined || toId === undefined) {
    throw new CliError(`缺少元素 id。用法: ${usage}`, EXIT.USAGE);
  }
  if (fromId === toId) {
    throw new CliError('源元素与目标元素不能相同', EXIT.USAGE);
  }

  const dir = resolveBoardDir(boardPath, args.options.get('board'));
  const handle = await openBoard(dir);
  const { scene } = handle;
  const from = scene.elements.find((e) => e.id === fromId);
  const to = scene.elements.find((e) => e.id === toId);
  if (!from) {
    throw new CliError(`未找到源元素：${fromId}`, EXIT.NOT_FOUND);
  }
  if (!to) {
    throw new CliError(`未找到目标元素：${toId}`, EXIT.NOT_FOUND);
  }

  // --arrow（末端箭头样式，默认 arrow）；--routing（默认 straight）
  const arrowRaw = args.options.get('arrow') ?? 'arrow';
  if (!VALID_ARROWS.has(arrowRaw)) {
    throw new CliError(
      `--arrow 必须为 none/arrow/triangle/dot（实际：${arrowRaw}）`,
      EXIT.USAGE,
    );
  }
  const endArrow = arrowRaw as ArrowHead;
  const routingRaw = args.options.get('routing') ?? 'straight';
  if (!VALID_ROUTING.has(routingRaw)) {
    throw new CliError(
      `--routing 必须为 straight/orthogonal/curved（实际：${routingRaw}）`,
      EXIT.USAGE,
    );
  }
  const routing = routingRaw as ConnectorRouting;

  const actor =
    args.options.get('actor') ?? args.options.get('agent') ?? DEFAULT_ACTOR;
  const z = nextZ(scene.elements);

  // 连线几何：源中心 → 目标中心（Web 端渲染时按端点最新位置重算）。
  const ax = from.x + from.width / 2;
  const ay = from.y + from.height / 2;
  const bx = to.x + to.width / 2;
  const by = to.y + to.height / 2;

  const label = args.options.get('label');
  const element = createConnectorElement({
    x: ax,
    y: ay,
    width: Math.abs(bx - ax),
    height: Math.abs(by - ay),
    createdBy: actor,
    z,
    start: { elementId: fromId, anchor: 'auto' },
    end: { elementId: toId, anchor: 'auto' },
    endArrow,
    routing,
    label,
  });
  scene.elements.push(element);
  await handle.save(scene);

  return {
    code: EXIT.OK,
    text: `已连线 ${element.id}（${fromId} → ${toId}）`,
    data: {
      elementId: element.id,
      from: fromId,
      to: toId,
      endArrow,
      routing,
      label: label ?? null,
    },
  };
}
