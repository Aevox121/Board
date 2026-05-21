/**
 * 文本卡片 —— DOM 覆盖层内渲染一个 `text` 元素（数据模型 §6.4 / PRD §6.3）。
 *
 * `text` 是白板原生的「文本 / Markdown 卡片」：正文（`markdown`）内联存于
 * board.json，不对应 files/ 下的文件（区别于 `file` 元素的 Markdown 文件预览）。
 *
 * 显示态由 `editMode` 给定初值，可在卡片右上角即时切换：
 *  - `preview` —— marked 渲染为格式化 HTML。
 *  - `source`  —— 显示 Markdown 源码。
 *
 * 就地编辑（自研画布层增量4）：双击卡片正文进入编辑，文本域改 `draft`，
 * 失焦 / Ctrl+Enter 提交（经 `onCommit` 写回场景），Esc 取消。
 */
import { useEffect, useRef, useState } from 'react';
import type { TextElement } from '@board/core';
import { marked } from 'marked';
import { cardRotation } from './util';

export interface TextCardProps {
  element: TextElement;
  /** 就地编辑提交正文 —— 由 OverlayLayer 写回场景；缺省则不可编辑。 */
  onCommit?: (markdown: string) => void;
}

export function TextCard({ element, onCommit }: TextCardProps): JSX.Element {
  const { markdown, editMode } = element;
  // 初值取元素 editMode；之后由卡片上的切换按钮本地控制。
  const [mode, setMode] = useState<'source' | 'preview'>(editMode);
  // 就地编辑态：editing=true 时正文区换成文本域。
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(markdown);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const rotation = cardRotation(element.id);
  const isPreview = mode === 'preview';

  // marked.parse 同步返回 string（未启用 async 选项）。
  const html = isPreview && markdown ? (marked.parse(markdown) as string) : '';

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

  return (
    <div
      className="ov-card ov-text"
      style={{ transform: `rotate(${rotation}deg)` }}
    >
      <div className="ov-text__bar">
        <span className="ov-text__tag" aria-hidden="true">
          ✏ 文本
        </span>
        {!editing ? (
          <button
            type="button"
            className="ov-text__toggle"
            // 阻止 pointerdown 冒泡到卡片槽，避免点切换按钮被当成拖拽起手。
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setMode(isPreview ? 'source' : 'preview')}
            title={isPreview ? '查看 Markdown 源码' : '渲染预览'}
          >
            {isPreview ? '源码' : '预览'}
          </button>
        ) : null}
      </div>
      {editing ? (
        <textarea
          ref={taRef}
          className="ov-text__body ov-text__editor"
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
      ) : isPreview ? (
        markdown ? (
          <div
            className="ov-text__body ov-md"
            onDoubleClick={beginEdit}
            // marked 输出来自本地白板数据，受信，M2 直接内联。
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <div
            className="ov-text__body ov-text__empty"
            onDoubleClick={beginEdit}
          >
            {onCommit ? '（空文本卡片 · 双击编辑）' : '（空文本卡片）'}
          </div>
        )
      ) : (
        <pre
          className="ov-text__body ov-text__source"
          onDoubleClick={beginEdit}
        >
          {markdown}
        </pre>
      )}
    </div>
  );
}
