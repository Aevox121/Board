/**
 * 文本卡片 —— DOM 覆盖层内渲染一个 `text` 元素（数据模型 §6.4 / PRD §6.3）。
 *
 * `text` 是白板原生的「文本 / Markdown 卡片」：正文（`markdown`）内联存于
 * board.json，不对应 files/ 下的文件（区别于 `file` 元素的 Markdown 文件预览）。
 *
 * 显示：始终格式化渲染（preview）。透明背景 + 纯文本浮在画布上，没有标题栏 /
 * source/preview 切换按钮。双击进入就地编辑，编辑时显示边框。
 *
 * 就地编辑（自研画布层增量4）：双击卡片正文进入编辑，文本域改 `draft`，
 * 失焦 / Ctrl+Enter 提交（经 `onCommit` 写回场景），Esc 取消。
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Style, TextElement } from '@board/core';
import { marked } from 'marked';
import { cardRotation } from './util';

/** fontFamily 枚举 → CSS 字体栈（与 ShapeView 同款映射）。 */
function fontStack(family: Style['fontFamily']): string {
  if (family === 'code') return 'var(--font-code, ui-monospace, monospace)';
  if (family === 'normal') return 'var(--font-ui, system-ui, sans-serif)';
  return 'var(--font-hand, "Comic Sans MS", cursive)';
}

export interface TextCardProps {
  element: TextElement;
  /** 就地编辑提交正文 —— 由 OverlayLayer 写回场景；缺省则不可编辑。 */
  onCommit?: (markdown: string) => void;
}

export function TextCard({ element, onCommit }: TextCardProps): JSX.Element {
  const { markdown } = element;
  // 就地编辑态：editing=true 时正文区换成文本域。
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(markdown);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const rotation = cardRotation(element.id);

  // marked.parse 同步返回 string（未启用 async 选项）。
  const html = markdown ? (marked.parse(markdown) as string) : '';

  // 进入编辑 —— 聚焦并全选，方便直接覆写占位文本。
  useEffect(() => {
    if (editing && taRef.current) {
      taRef.current.focus();
      taRef.current.select();
    }
  }, [editing]);

  const beginEdit = (): void => {
    if (!onCommit) return;
    setDraft(markdown);
    setEditing(true);
  };
  const commit = (): void => {
    setEditing(false);
    if (onCommit && draft !== markdown) onCommit(draft);
  };
  const cancel = (): void => {
    setEditing(false);
    setDraft(markdown);
  };

  // 选区面板「文字」节所改的字体 / 字号 —— 应用到正文区。
  const bodyStyle: CSSProperties = {
    fontSize: `${element.style.fontSize}px`,
    fontFamily: fontStack(element.style.fontFamily),
  };

  const className =
    'ov-card ov-text' + (editing ? ' ov-text--editing' : '');

  return (
    <div className={className} style={{ transform: `rotate(${rotation}deg)` }}>
      {editing ? (
        <textarea
          ref={taRef}
          className="ov-text__body ov-text__editor"
          style={bodyStyle}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          // 文本域内的指针操作不触发卡片拖拽。
          onPointerDown={(e) => e.stopPropagation()}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
            } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              commit();
            }
          }}
        />
      ) : markdown ? (
        <div
          className="ov-text__body ov-md"
          style={bodyStyle}
          onDoubleClick={beginEdit}
          // marked 输出来自本地白板数据，受信，M2 直接内联。
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <div
          className="ov-text__body ov-text__empty"
          style={bodyStyle}
          onDoubleClick={beginEdit}
        >
          {onCommit ? '（空文本卡片 · 双击编辑）' : '（空文本卡片）'}
        </div>
      )}
    </div>
  );
}
