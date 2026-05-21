/**
 * `board show <路径> [--region <名>] [--depth <n>]` — 导出白板上下文（Board Context）。
 *
 * 规格 §2.4 / PRD §7.1：Agent 在行动前获取白板上下文。**渐进式披露** —— 不一次
 * 全量塞给 Agent，而是分层按需展开：
 *  - `--depth 0`（默认）—— 概览：区域列表及描述、各区域文件/元素数、连线/建议计数。
 *  - `--depth 1` —— 含区域内元素列表（id / 类型 / 摘要）、连线与建议明细。
 *  - `--depth 2` —— 再含元素正文（text 卡的 markdown、文本类文件的内容片段）。
 * `--region <名>` 把上下文收窄到单个区域。
 *
 * 元素归属区域以 `parentId` 为准；连线 / 建议作为白板级拓扑单列。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadBoard } from '@board/core/node';
import {
  guessMime,
  regionsOf,
  type Element,
  type RegionElement,
  type ThreadMsg,
} from '@board/core';
import type { ParsedArgs } from '../util/args.js';
import { CliError, EXIT, type CmdResult } from '../util/io.js';
import { resolveBoardDir } from '../util/board.js';

/** depth 2 内联文件正文的字符上限（超出截断）。 */
const CONTENT_CAP = 2000;

/** 渐进式披露层级。 */
type Depth = 0 | 1 | 2;

/** 元素简报（depth ≥ 1）。 */
interface ElementBrief {
  id: string;
  type: Element['type'];
  /** file/folder 的相对路径 */
  path?: string;
  /** 一句话摘要 */
  summary: string;
  /** depth 2 的元素正文（text markdown / 文本文件内容片段） */
  content?: string;
}

/** 区域视图。 */
interface RegionView {
  id: string;
  label: string;
  description: string;
  fileCount: number;
  elementCount: number;
  /** depth ≥ 1 */
  elements?: ElementBrief[];
}

/** 解析 `--depth`，默认 0。 */
function parseDepth(raw: string | undefined): Depth {
  if (raw === undefined) return 0;
  if (raw === '0') return 0;
  if (raw === '1') return 1;
  if (raw === '2') return 2;
  throw new CliError(`--depth 必须为 0 / 1 / 2（实际：${raw}）`, EXIT.USAGE);
}

/** 截断长字符串，超出加省略标记。 */
function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 元素一句话摘要。 */
function elementSummary(el: Element): string {
  switch (el.type) {
    case 'file':
      return el.path;
    case 'folder':
      return `${el.path}/`;
    case 'region':
      return el.label;
    case 'text': {
      const first =
        el.markdown.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
      return first === '' ? '（空文本卡）' : truncate(first, 48);
    }
    case 'shape':
      return el.label?.text ? `${el.shape}「${el.label.text}」` : el.shape;
    case 'connector':
      return el.label?.text ?? '连线';
    case 'suggestion':
      return `建议（${el.suggestionType}）→ ${el.targetId}`;
    case 'image':
      return el.path ?? '画布图片';
    default:
      return el.type;
  }
}

/**
 * depth 2：建议 payload 的内容视图 —— 让 Agent 看清「提议的内容」本身。
 * payload 是同意后会并入白板的纯内容（text 卡 / 图形等）。
 */
function suggestionPayloadView(payload: Element): Record<string, unknown> {
  const view: Record<string, unknown> = { type: payload.type };
  if (payload.type === 'text') {
    view['markdown'] = payload.markdown;
  } else if (payload.type === 'shape') {
    view['label'] = payload.label?.text ?? null;
  } else {
    view['summary'] = elementSummary(payload);
  }
  return view;
}

/** 该路径是否为可内联的文本类文件。 */
function isTextLike(path: string): boolean {
  const mime = guessMime(path);
  return mime.startsWith('text/') || mime === 'application/json';
}

/** depth 2：取元素正文。 */
async function elementContent(
  el: Element,
  dir: string,
): Promise<string | undefined> {
  if (el.type === 'text') return el.markdown;
  if (el.type === 'file') {
    if (!isTextLike(el.path)) {
      return `（${guessMime(el.path)}，${el.size} 字节，非文本不内联）`;
    }
    try {
      const raw = await readFile(join(dir, 'files', el.path), 'utf8');
      return truncate(raw, CONTENT_CAP);
    } catch {
      return '（文件读取失败 / 已缺失）';
    }
  }
  return undefined;
}

/** 把一个元素转为 ElementBrief（depth 2 时附正文）。 */
async function toBrief(
  el: Element,
  depth: Depth,
  dir: string,
): Promise<ElementBrief> {
  const brief: ElementBrief = {
    id: el.id,
    type: el.type,
    summary: elementSummary(el),
  };
  if (el.type === 'file' || el.type === 'folder') brief.path = el.path;
  if (depth === 2) {
    const content = await elementContent(el, dir);
    if (content !== undefined) brief.content = content;
  }
  return brief;
}

/** 在区域 / 收件区元素列表中纳入的类型（区域 / 连线 / 建议另算）。 */
function isListableElement(el: Element): boolean {
  return (
    el.type !== 'region' &&
    el.type !== 'connector' &&
    el.type !== 'suggestion'
  );
}

/** 执行 show 命令。 */
export async function cmdShow(args: ParsedArgs): Promise<CmdResult> {
  const dir = resolveBoardDir(args.positionals[0], args.options.get('board'));
  const handle = await loadBoard(dir);
  const { scene } = handle;
  const elements = scene.elements;

  const depth = parseDepth(args.options.get('depth'));
  const regionFilter = args.options.get('region')?.trim();

  const allRegions = regionsOf(elements);
  let regions: RegionElement[] = allRegions;
  if (regionFilter !== undefined && regionFilter !== '') {
    regions = allRegions.filter(
      (r) => r.label === regionFilter || r.path === regionFilter,
    );
    if (regions.length === 0) {
      throw new CliError(`未找到区域：${regionFilter}`, EXIT.NOT_FOUND);
    }
  }

  // 各区域的子元素（parentId 归属），收件区 = parentId 为 null 的可列元素。
  const regionViews: RegionView[] = [];
  for (const r of regions) {
    const kids = elements.filter(
      (e) => e.parentId === r.id && isListableElement(e),
    );
    const view: RegionView = {
      id: r.id,
      label: r.label,
      description: r.description,
      fileCount: kids.filter((e) => e.type === 'file').length,
      elementCount: kids.length,
    };
    if (depth >= 1) {
      view.elements = await Promise.all(
        kids.map((e) => toBrief(e, depth, dir)),
      );
    }
    regionViews.push(view);
  }

  // 白板级拓扑：连线 / 建议。
  const connectors = elements.filter((e) => e.type === 'connector');
  const suggestions = elements.filter((e) => e.type === 'suggestion');

  // data —— 机器可读上下文包。
  const data: Record<string, unknown> = {
    name: handle.meta.name,
    depth,
    regions: regionViews,
  };

  if (regionFilter === undefined || regionFilter === '') {
    // 全板视图才含收件区与白板级拓扑。
    const loose = elements.filter(
      (e) => e.parentId === null && isListableElement(e),
    );
    data['loose'] = {
      fileCount: loose.filter((e) => e.type === 'file').length,
      elementCount: loose.length,
      ...(depth >= 1
        ? {
            elements: await Promise.all(
              loose.map((e) => toBrief(e, depth, dir)),
            ),
          }
        : {}),
    };
    data['connectorCount'] = connectors.length;
    data['suggestionCount'] = suggestions.length;
    if (depth >= 1) {
      data['connectors'] = connectors.map((c) =>
        c.type === 'connector'
          ? {
              id: c.id,
              from: c.start.elementId,
              to: c.end.elementId,
              label: c.label?.text ?? null,
            }
          : null,
      );
      data['suggestions'] = suggestions.map((s) => {
        if (s.type !== 'suggestion') return null;
        const view: Record<string, unknown> = {
          id: s.id,
          targetId: s.targetId,
          suggestionType: s.suggestionType,
          status: s.status,
          author: s.authorId,
          reason: s.reason ?? '',
          threadLength: s.thread.length,
        };
        // depth 2：连同提议正文（payload）与「描述」反馈回路的全部对话
        // （thread）一并给出 —— Agent 据此读回人的修改意见并修订建议
        // （PRD §7.3 反馈回路）。depth 0/1 只给 threadLength 计数。
        if (depth === 2) {
          view['payload'] = suggestionPayloadView(s.payload);
          view['thread'] = s.thread;
        }
        return view;
      });
    }
  }

  return { code: EXIT.OK, text: renderText(data, depth, regionFilter), data };
}

/** 把上下文包渲染为人类可读文本。 */
function renderText(
  data: Record<string, unknown>,
  depth: Depth,
  regionFilter: string | undefined,
): string {
  const lines: string[] = [];
  lines.push(`白板: ${String(data['name'])}  (depth ${depth})`);
  if (regionFilter) lines.push(`（已收窄到区域：${regionFilter}）`);

  const regions = data['regions'] as RegionView[];
  lines.push(`区域 (${regions.length}):`);
  if (regions.length === 0) lines.push('  （无区域）');
  for (const r of regions) {
    const desc = r.description.trim() === '' ? '（无描述）' : r.description;
    lines.push(`  ▸ ${r.label} — ${desc}  [文件 ${r.fileCount} · 元素 ${r.elementCount}]`);
    appendBriefs(lines, r.elements, depth);
  }

  const loose = data['loose'] as
    | { fileCount: number; elementCount: number; elements?: ElementBrief[] }
    | undefined;
  if (loose) {
    lines.push(
      `收件区: 文件 ${loose.fileCount} · 元素 ${loose.elementCount}`,
    );
    appendBriefs(lines, loose.elements, depth);
  }

  if (data['connectorCount'] !== undefined) {
    lines.push(
      `连线: ${String(data['connectorCount'])} · 建议: ${String(data['suggestionCount'])}`,
    );
  }
  appendSuggestions(lines, data['suggestions'], depth);
  return lines.join('\n');
}

/** depth ≥ 1 时在文本输出里追加建议明细（depth 2 连「描述」反馈回路对话）。 */
function appendSuggestions(lines: string[], raw: unknown, depth: Depth): void {
  if (!Array.isArray(raw) || raw.length === 0) return;
  lines.push('建议:');
  for (const s of raw as Array<Record<string, unknown> | null>) {
    if (!s) continue;
    const reason = String(s['reason'] ?? '');
    lines.push(
      `  ◍ ${String(s['id'])} (${String(s['suggestionType'])} → ${String(s['targetId'])}) ` +
        `[${String(s['status'])}]` +
        (reason ? `  理由: ${truncate(reason, 60)}` : ''),
    );
    const thread = s['thread'] as ThreadMsg[] | undefined;
    if (depth === 2 && thread) {
      for (const m of thread) {
        const who = m.role === 'human' ? '👤 人' : '🤖 Agent';
        lines.push(`      ${who}: ${truncate(m.text, 80)}`);
      }
    } else {
      const n = Number(s['threadLength'] ?? 0);
      if (n > 0) lines.push(`      （${n} 条反馈，--depth 2 查看正文）`);
    }
  }
}

/** 在文本中追加一组元素简报（depth ≥ 1 才有；depth 2 含正文片段）。 */
function appendBriefs(
  lines: string[],
  briefs: ElementBrief[] | undefined,
  depth: Depth,
): void {
  if (!briefs) return;
  for (const b of briefs) {
    lines.push(`    · ${b.type}  ${b.summary}  (${b.id})`);
    if (depth === 2 && b.content !== undefined) {
      const preview = truncate(b.content.replace(/\s+/g, ' ').trim(), 96);
      lines.push(`        ${preview}`);
    }
  }
}
