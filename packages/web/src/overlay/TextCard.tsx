/**
 * 文本卡片 —— DOM 覆盖层内渲染一个 `text` 元素（数据模型 §6.4 / PRD §6.3）。
 *
 * `text` 是白板原生的「文本 / Markdown 卡片」：正文（`markdown`）内联存于
 * board.json，不对应 files/ 下的文件（区别于 `file` 元素的 Markdown 文件预览）。
 *
 * 显示态由 `editMode` 给定初值，可在卡片右上角即时切换：
 *  - `preview` —— marked 渲染为格式化 HTML。
 *  - `source`  —— 显示 Markdown 源码。
 * 切换只影响本地视图，不写回场景（持久化的就地编辑留待后续增量）。
 */
import { useState } from 'react';
import type { TextElement } from '@board/core';
import { marked } from 'marked';
import { cardRotation } from './util';

export interface TextCardProps {
  element: TextElement;
}

export function TextCard({ element }: TextCardProps): JSX.Element {
  const { markdown, editMode } = element;
  // 初值取元素 editMode；之后由卡片上的切换按钮本地控制。
  const [mode, setMode] = useState<'source' | 'preview'>(editMode);
  const rotation = cardRotation(element.id);
  const isPreview = mode === 'preview';

  // marked.parse 同步返回 string（未启用 async 选项）。
  const html =
    isPreview && markdown ? (marked.parse(markdown) as string) : '';

  return (
    <div
      className="ov-card ov-text"
      style={{ transform: `rotate(${rotation}deg)` }}
    >
      <div className="ov-text__bar">
        <span className="ov-text__tag" aria-hidden="true">
          ✏ 文本
        </span>
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
      </div>
      {isPreview ? (
        markdown ? (
          <div
            className="ov-text__body ov-md"
            // marked 输出来自本地白板数据，受信，M2 直接内联。
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <div className="ov-text__body ov-text__empty">（空文本卡片）</div>
        )
      ) : (
        <pre className="ov-text__body ov-text__source">{markdown}</pre>
      )}
    </div>
  );
}
