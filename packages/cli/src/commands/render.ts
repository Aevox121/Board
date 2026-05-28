/**
 * `board render <白板路径> ...` — 把白板渲成缩略图（M5 L4）。
 *
 * 规格：board render <白板> [--region <名>] [--bbox "x,y,w,h"]
 *        [--format svg|png] [--out <文件>] [--max-size <n>]
 *
 * 读操作（不改场景）：经 readBoard 取权威场景 → core renderSceneSvg 拼 SVG →
 * 按 format 写文件（png 走 resvg 光栅化）。默认输出到 `<板>/.runtime/renders/`。
 * 让人 / Agent 看一眼整体版面（对齐 / 成组 / 出框 / 越界）。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderSceneSvg, regionsOf, type RenderOptions } from '@board/core';
import type { ParsedArgs } from '../util/args.js';
import { CliError, EXIT, type CmdResult } from '../util/io.js';
import { resolveBoardDir } from '../util/board.js';
import { readBoard } from '../util/board-io.js';
import { svgToPng } from '../util/rasterize.js';

const VALID_FORMATS: ReadonlySet<string> = new Set(['svg', 'png']);

/** 解析 `"x,y,w,h"` → bbox；缺省返回 undefined，非法抛 USAGE。 */
function parseBbox(
  raw: string | undefined,
): { x: number; y: number; width: number; height: number } | undefined {
  if (!raw) return undefined;
  const p = raw.split(',').map((s) => Number(s.trim()));
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n)) || p[2]! <= 0 || p[3]! <= 0) {
    throw new CliError(`--bbox 必须形如 "x,y,w,h"（w/h 为正），收到: ${raw}`, EXIT.USAGE);
  }
  return { x: p[0]!, y: p[1]!, width: p[2]!, height: p[3]! };
}

export async function cmdRender(args: ParsedArgs): Promise<CmdResult> {
  const boardPath = args.positionals[0];
  const usage =
    'board render <白板路径> [--region <名>] [--bbox "x,y,w,h"] [--format svg|png] [--out <文件>] [--max-size <n>]';
  if (boardPath === undefined) {
    throw new CliError(`缺少白板路径。用法: ${usage}`, EXIT.USAGE);
  }

  const format = (args.options.get('format') ?? 'png').trim();
  if (!VALID_FORMATS.has(format)) {
    throw new CliError(`--format 必须为 svg/png，收到: ${format}`, EXIT.USAGE);
  }
  const maxSizeRaw = args.options.get('max-size');
  const maxSize = maxSizeRaw !== undefined ? Number(maxSizeRaw) : undefined;
  if (maxSize !== undefined && (!Number.isFinite(maxSize) || maxSize < 100)) {
    throw new CliError(`--max-size 必须 ≥ 100，收到: ${maxSizeRaw}`, EXIT.USAGE);
  }
  const bbox = parseBbox(args.options.get('bbox'));
  const regionName = args.options.get('region')?.trim();

  const dir = resolveBoardDir(boardPath, args.options.get('board'));
  const { scene } = await readBoard(dir);

  const renderOpts: RenderOptions = {};
  if (maxSize !== undefined) renderOpts.maxSize = maxSize;
  if (bbox) renderOpts.bbox = bbox;
  if (regionName) {
    const region = regionsOf(scene.elements).find(
      (r) => r.label === regionName || r.path === regionName,
    );
    if (!region) {
      throw new CliError(`未找到区域：${regionName}`, EXIT.NOT_FOUND);
    }
    renderOpts.regionId = region.id;
  }

  const result = renderSceneSvg(scene, renderOpts);

  // 输出路径：--out 或默认 .runtime/renders/render-<ts>.<ext>
  const outArg = args.options.get('out');
  const outPath =
    outArg ?? join(dir, '.runtime', 'renders', `render-${Date.now()}.${format}`);
  await mkdir(join(outPath, '..'), { recursive: true });

  if (format === 'svg') {
    await writeFile(outPath, result.svg, 'utf8');
  } else {
    const png = await svgToPng(result.svg, result.pixelWidth);
    await writeFile(outPath, png);
  }

  return {
    code: EXIT.OK,
    text: `已渲染 ${result.elementCount} 个元素 → ${outPath}  (${result.pixelWidth}×${result.pixelHeight})`,
    data: {
      path: outPath,
      format,
      bbox: result.bbox,
      pixelWidth: result.pixelWidth,
      pixelHeight: result.pixelHeight,
      elementCount: result.elementCount,
    },
  };
}
