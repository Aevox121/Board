/**
 * `board search <白板路径> "<关键词>"` — 搜索元素文字 / 文件名 / 文件内容。
 *
 * 规格 §2.4：结果含元素 id 与定位。文本类文件读正文一并搜索，
 * 二进制文件只搜文件名。大小写不敏感。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadBoard } from '@board/core/node';
import { guessMime, type Element } from '@board/core';
import type { ParsedArgs } from '../util/args.js';
import { CliError, EXIT, type CmdResult } from '../util/io.js';
import { resolveBoardDir } from '../util/board.js';

/** 一条搜索命中。 */
interface SearchHit {
  elementId: string;
  type: Element['type'];
  /** 命中字段：text / label / path / content / description / payload / reason */
  field: string;
  /** 命中处片段 */
  snippet: string;
}

/** 该路径是否为可读正文的文本类文件。 */
function isTextLike(path: string): boolean {
  const m = guessMime(path);
  return m.startsWith('text/') || m === 'application/json';
}

/** 取关键词周边片段（首个命中处前后各 ~24 字）。 */
function snippetOf(text: string, kw: string): string {
  const i = text.toLowerCase().indexOf(kw.toLowerCase());
  if (i < 0) return text.slice(0, 48).replace(/\s+/g, ' ').trim();
  const s = Math.max(0, i - 24);
  const e = Math.min(text.length, i + kw.length + 24);
  return (
    (s > 0 ? '…' : '') +
    text.slice(s, e).replace(/\s+/g, ' ').trim() +
    (e < text.length ? '…' : '')
  );
}

/** 执行 search 命令。 */
export async function cmdSearch(args: ParsedArgs): Promise<CmdResult> {
  const boardPath = args.positionals[0];
  const keyword = args.positionals[1];
  if (boardPath === undefined) {
    throw new CliError(
      '缺少白板路径。用法: board search <白板路径> "<关键词>"',
      EXIT.USAGE,
    );
  }
  if (keyword === undefined || keyword.trim() === '') {
    throw new CliError(
      '缺少关键词。用法: board search <白板路径> "<关键词>"',
      EXIT.USAGE,
    );
  }
  const kw = keyword.trim();
  const kwLower = kw.toLowerCase();
  const has = (s: string | undefined | null): boolean =>
    typeof s === 'string' && s.toLowerCase().includes(kwLower);

  const dir = resolveBoardDir(boardPath, args.options.get('board'));
  const handle = await loadBoard(dir);
  const hits: SearchHit[] = [];

  for (const el of handle.scene.elements) {
    if (el.type === 'text') {
      if (has(el.markdown)) {
        hits.push({ elementId: el.id, type: el.type, field: 'text', snippet: snippetOf(el.markdown, kw) });
      }
    } else if (el.type === 'shape') {
      if (el.label && has(el.label.text)) {
        hits.push({ elementId: el.id, type: el.type, field: 'label', snippet: el.label.text });
      }
    } else if (el.type === 'connector') {
      if (el.label && has(el.label.text)) {
        hits.push({ elementId: el.id, type: el.type, field: 'label', snippet: el.label.text });
      }
    } else if (el.type === 'region') {
      if (has(el.label)) {
        hits.push({ elementId: el.id, type: el.type, field: 'label', snippet: el.label });
      } else if (has(el.description)) {
        hits.push({ elementId: el.id, type: el.type, field: 'description', snippet: snippetOf(el.description, kw) });
      }
    } else if (el.type === 'suggestion') {
      if (el.payload.type === 'text' && has(el.payload.markdown)) {
        hits.push({ elementId: el.id, type: el.type, field: 'payload', snippet: snippetOf(el.payload.markdown, kw) });
      } else if (has(el.reason)) {
        hits.push({ elementId: el.id, type: el.type, field: 'reason', snippet: snippetOf(el.reason, kw) });
      }
    } else if (el.type === 'file') {
      if (has(el.path)) {
        hits.push({ elementId: el.id, type: el.type, field: 'path', snippet: el.path });
      } else if (isTextLike(el.path)) {
        try {
          const content = await readFile(join(dir, 'files', el.path), 'utf8');
          if (has(content)) {
            hits.push({ elementId: el.id, type: el.type, field: 'content', snippet: snippetOf(content, kw) });
          }
        } catch {
          // 文件读不到（已缺失等）—— 跳过内容搜索。
        }
      }
    }
  }

  const text =
    hits.length === 0
      ? `未找到含「${kw}」的元素。`
      : [
          `含「${kw}」的元素 (${hits.length}):`,
          ...hits.map((h) => `  ${h.type} · ${h.field}  ${h.snippet}  (${h.elementId})`),
        ].join('\n');

  return { code: EXIT.OK, text, data: { keyword: kw, count: hits.length, hits } };
}
