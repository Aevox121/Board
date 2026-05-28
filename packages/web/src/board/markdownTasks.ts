/**
 * Markdown GFM 任务列表勾选互动（PRD §6.3）。
 *
 * marked 默认把 `- [ ]` / `- [x]` 渲染成 `<input type="checkbox" disabled>` ——
 * 用户点不动，且没办法回写源 markdown。本模块做两件事：
 *
 *  1. `renderMarkdownWithTaskIndex(md)`：跑 marked.parse 后做轻量后处理，
 *     把每个 `<input type="checkbox" ...>` 去掉 `disabled` 属性 + 按出现
 *     顺序加上 `data-task-index="0"`、`"1"` …，让 DOM 事件能定位到源里
 *     第 N 个任务行。
 *
 *  2. `toggleMarkdownTask(md, n)`：在源 markdown 里找第 n 个任务行
 *     （`- [ ]` / `* [x]` / `+ [X]` 与可选缩进 / blockquote 前缀），把方括号
 *     里的状态翻转，返回新 markdown。索引超界则原样返回，调用方据此忽略。
 *
 * 解析规则与 GFM 任务列表对齐：任务行 = bullet 列表项（`-` / `*` / `+`），
 * 紧跟 `[ ]` / `[x]` / `[X]`，之后留一个空格再接文本。允许行首任意缩进
 * （子任务）和 `>` blockquote 前缀。numbered list（`1.`）不计入。
 */

import { marked } from 'marked';
import type { Element, RegionElement } from '@board/core';

// 单个换行也当硬换行（<br>）渲染 —— 用户在文本卡里敲的回车、以及 Agent 写入
// 的多行 markdown，都按所见保留，不被 CommonMark「单换行并成空格」吃掉。
// 仍启用 GFM（任务列表 / 表格 / 删除线）。文本卡与文件 md 预览共用此配置。
marked.setOptions({ gfm: true, breaks: true });

/** 匹配「任务行的方括号位置」—— 仅取方括号本身，避免误改正文里的 `[x]`。 */
const TASK_LINE_RE = /^([ \t]*(?:>\s*)*[-*+]\s+)\[([ xX])\]/gm;

/**
 * 在 marked 解析输出里把 checkbox 解锁 + 标 data-task-index。
 *
 * 实现：marked 输出固定形如 `<input disabled="" type="checkbox" checked="">`
 * 或 `<input disabled="" type="checkbox">`。简单字符串替换够用，避免 DOM
 * 解析开销；任何其它 `<input>` 不动。
 */
export function renderMarkdownWithTaskIndex(md: string): string {
  const html = marked.parse(md ?? '') as string;
  let idx = 0;
  return html.replace(
    /<input([^>]*?)type="checkbox"([^>]*?)>/g,
    (_match, before: string, after: string) => {
      const attrs = (before + after).replace(/\s*disabled(="")?/g, '');
      const dataIdx = ` data-task-index="${idx++}"`;
      return `<input type="checkbox"${attrs}${dataIdx}>`;
    },
  );
}

/**
 * 翻转源 markdown 里第 n 个任务行的勾选状态。
 *
 * @returns 新 markdown；n 超界 / 找不到任务则返回原 md（让调用方判断 no-op）
 */
export function toggleMarkdownTask(md: string, n: number): string {
  if (n < 0) return md;
  let i = 0;
  const next = md.replace(TASK_LINE_RE, (match, prefix: string, mark: string) => {
    const cur = i;
    i += 1;
    if (cur !== n) return match;
    const flipped = mark === ' ' ? 'x' : ' ';
    return `${prefix}[${flipped}]`;
  });
  return next;
}

// ─────────────────────────────────────────────────────────────────────
//  内链 [[xxx]]（PRD §6.3 「支持 `[[白板内文件]]` 风格内链」）
// ─────────────────────────────────────────────────────────────────────

/** 把 `[[xxx]]` 解析到场景里的某个元素。找不到返回 null（死链）。
 *
 * 解析优先级：
 *  1. file 元素 path 完全匹配（`[[路线/day1.md]]`）
 *  2. file 元素 basename 完全匹配（`[[day1.md]]`）
 *  3. region label 完全匹配（`[[路线]]`）
 *  4. folder 元素 basename 完全匹配
 *  5. file basename 去扩展名后完全匹配（`[[day1]]`）
 *  6. text 元素首非空行前缀匹配（`[[华山三日攻略]]`，便于跳到笔记节）
 * 名称 trim 后参与匹配；大小写敏感（路径敏感的文件系统多数大小写敏感）。 */
export function resolveInternalLink(
  elements: ReadonlyArray<Element>,
  rawName: string,
): Element | null {
  const name = rawName.trim();
  if (!name) return null;
  const baseOf = (p: string): string => {
    const i = p.lastIndexOf('/');
    return i >= 0 ? p.slice(i + 1) : p;
  };
  const noExt = (b: string): string => {
    const i = b.lastIndexOf('.');
    return i > 0 ? b.slice(0, i) : b;
  };

  // 1) file path 精确
  for (const e of elements) {
    if (e.type === 'file' && e.path === name) return e;
  }
  // 2) file basename 精确
  for (const e of elements) {
    if (e.type === 'file' && baseOf(e.path) === name) return e;
  }
  // 3) region label 精确
  for (const e of elements) {
    if (e.type === 'region' && (e as RegionElement).label === name) return e;
  }
  // 4) folder basename 精确
  for (const e of elements) {
    if (e.type === 'folder' && baseOf(e.path) === name) return e;
  }
  // 5) file basename 去扩展名 精确
  for (const e of elements) {
    if (e.type === 'file' && noExt(baseOf(e.path)) === name) return e;
  }
  // 6) text 元素首行前缀
  for (const e of elements) {
    if (e.type !== 'text') continue;
    const md = e.markdown ?? '';
    const firstLine = md.split('\n').find((l) => l.trim()) ?? '';
    // 去掉 markdown 标记字符（# > - * 等）后做前缀比较
    const stripped = firstLine.replace(/^[#>\-*+\s]+/, '').trim();
    if (stripped.startsWith(name)) return e;
  }
  return null;
}

/** 转义 HTML 文本（避免链接名包含 `<>&"` 时破坏 DOM）。 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 把 HTML 字符串里出现在「标签外」的 `[[xxx]]` 文本替换为可点击链接 / 死链。
 *
 * 只在 `>` 与 `<` 之间的文本片段做替换 —— 避开属性值（如 `href="..."` 含 `[`）
 * 与 `<code>` / `<pre>`（避免代码块里的 `[[]]` 被吃掉）。
 *
 * 命中元素 → `<a class="ov-md-link" data-bd-link="<id>">xxx</a>`
 * 未命中  → `<span class="ov-md-link ov-md-link--dead" title="未找到">xxx</span>`
 */
function replaceInternalLinksInHtml(
  html: string,
  elements: ReadonlyArray<Element>,
): string {
  // 把 HTML 切成 tag / text 交替片段。text 段才做替换；tag 段（含 `<code>`
  // / `<pre>` 内部一同视为 tag，因 marked 输出 `<code>...</code>` 内部仍是
  // 文本节点 —— 用 inCodeDepth 计数标签嵌套来跳过代码块）。
  const out: string[] = [];
  let i = 0;
  let codeDepth = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      // 末尾文本
      out.push(
        codeDepth > 0 ? html.slice(i) : transformText(html.slice(i)),
      );
      break;
    }
    // 文本片段
    if (lt > i) {
      const seg = html.slice(i, lt);
      out.push(codeDepth > 0 ? seg : transformText(seg));
    }
    // 标签片段
    const gt = html.indexOf('>', lt);
    if (gt < 0) {
      out.push(html.slice(lt));
      break;
    }
    const tag = html.slice(lt, gt + 1);
    out.push(tag);
    // 维护 code/pre 深度（marked 会输出 `<code>` / `<pre>`；嵌套通常 1 层）
    if (/^<\s*(code|pre)\b/i.test(tag)) codeDepth += 1;
    else if (/^<\s*\/\s*(code|pre)\s*>/i.test(tag)) {
      codeDepth = Math.max(0, codeDepth - 1);
    }
    i = gt + 1;
  }
  return out.join('');

  function transformText(text: string): string {
    return text.replace(/\[\[([^\[\]]+)\]\]/g, (_m, raw: string) => {
      const target = resolveInternalLink(elements, raw);
      const label = escapeHtml(raw);
      if (target) {
        return `<a class="ov-md-link" data-bd-link="${escapeHtml(target.id)}">${label}</a>`;
      }
      return `<span class="ov-md-link ov-md-link--dead" title="未找到该元素">${label}</span>`;
    });
  }
}

/**
 * 完整 markdown 渲染：marked.parse + 任务列表可勾选 + 内链 `[[xxx]]` 解析。
 *
 * 这是 TextCard / FileCard 都用的单一入口；旧的 `renderMarkdownWithTaskIndex`
 * 不知道场景元素故只能做任务列表，本函数补上内链支持。
 */
export function renderMarkdownRich(
  md: string,
  elements: ReadonlyArray<Element>,
): string {
  const withTasks = renderMarkdownWithTaskIndex(md);
  return replaceInternalLinksInHtml(withTasks, elements);
}

/** 计数源 markdown 里的任务行数 —— 给 UI 显示「已完成 / 总数」用，可选。 */
export function countMarkdownTasks(md: string): { total: number; done: number } {
  let total = 0;
  let done = 0;
  md.replace(TASK_LINE_RE, (_match, _prefix: string, mark: string) => {
    total += 1;
    if (mark !== ' ') done += 1;
    return _match;
  });
  return { total, done };
}
