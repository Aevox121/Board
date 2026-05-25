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
