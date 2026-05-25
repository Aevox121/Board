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
import { useBoard } from '../board/BoardContext';
import { cardRotation } from './util';
import {
  renderMarkdownRich,
  toggleMarkdownTask,
} from '../board/markdownTasks';

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
  /**
   * 内容高度变化回调（PRD §6.4：文本卡按内容自适应）。
   * 当渲染后的 body 高度与 element.height 偏差超 4px 时回调，OverlayLayer
   * 据此把新高度写回 element.height（含 ResizeObserver 的字号 / 内容变化）。
   * 不传则不自动撑高。
   */
  onResize?: (height: number) => void;
  /**
   * 编辑态（外部控制）—— OverlayLayer 因为 slot 抢占了 pointer capture，
   * 内层 body 的 onDoubleClick 不再可达；改由 slot.onDoubleClick 把
   * `editingId` 提上来，TextCard 据此进入 / 退出编辑态。
   * 不传或为 false = 默认非编辑态。
   */
  editing?: boolean;
  /** 用户按 Esc / 失焦 / Ctrl+Enter 退出编辑时通知调用方清状态。 */
  onEditingChange?: (editing: boolean) => void;
}

export function TextCard({
  element,
  onCommit,
  onResize,
  editing: editingProp,
  onEditingChange,
}: TextCardProps): JSX.Element {
  const { markdown } = element;
  const { scene, requestNavigateToElement } = useBoard();
  // 编辑态：受控（来自 props）+ 受控失败时本地兜底；优先用 props。
  const editing = Boolean(editingProp);
  const [draft, setDraft] = useState(markdown);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLElement | null>(null);
  const rotation = cardRotation(element.id);

  // 自适应高度：ResizeObserver 观察 body 实际高度，与 element.height 偏差
  // 超过 4px 即回调（防抖由 OverlayLayer 端做）。编辑态不上报 —— textarea
  // 的尺寸是 fixed 高度，不参与 fit。
  useEffect(() => {
    if (!onResize || editing) return;
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const h = Math.ceil(entry.contentRect.height + entry.contentRect.top);
        // contentRect.top 是 body 相对 .ov-text 顶部的偏移（含 padding-top 已
        // 在 entry.contentRect.height 内）。padding-top 已是 body 的一部分。
        // 直接 body 自身高度 + body 在 ov-text 内的 offsetTop
        const fullH = (el as HTMLElement).offsetTop + (el as HTMLElement).offsetHeight;
        if (Math.abs(fullH - element.height) > 4) onResize(fullH);
        void h;
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [onResize, editing, element.height]);

  // marked 的输出可能在异步 / 字体加载后才稳定布局；mount 后再测一次兜底
  useEffect(() => {
    if (!onResize || editing) return;
    const el = bodyRef.current as HTMLElement | null;
    if (!el) return;
    const fullH = el.offsetTop + el.offsetHeight;
    if (Math.abs(fullH - element.height) > 4) onResize(fullH);
  }, [markdown, onResize, editing, element.height]);

  // 渲染 markdown + 让 GFM 任务列表的 checkbox 可点（去 disabled + 加
  // data-task-index） + `[[xxx]]` 内链解析（数据来自场景元素，
  // 命中后 data-bd-link=元素 id）。body onClick 委托处理勾选回写 / 跳转。
  const html = markdown ? renderMarkdownRich(markdown, scene.elements) : '';

  /** 命中 checkbox / 内链 —— pointerdown 阶段就拦截，否则 slot 会
   *  setPointerCapture 把后续 click 重定向到 slot 上。 */
  function handleBodyPointerDown(e: React.PointerEvent<HTMLElement>): void {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    if (t.tagName === 'INPUT' && (t as HTMLInputElement).type === 'checkbox') {
      e.stopPropagation();
      return;
    }
    if (t.tagName === 'A' && t.classList.contains('ov-md-link')) {
      e.stopPropagation();
    }
  }

  /** 委托点击 —— 命中 checkbox 翻转任务；命中内链跳到目标元素。 */
  function handleBodyClick(e: React.MouseEvent<HTMLElement>): void {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    // 内链 [[xxx]] —— 命中则跳到目标元素（dead 链 class 也带 ov-md-link
    // 但无 data-bd-link，自然 no-op）。
    if (t.tagName === 'A' && t.classList.contains('ov-md-link')) {
      const id = t.dataset['bdLink'];
      if (id) {
        e.preventDefault();
        e.stopPropagation();
        requestNavigateToElement(id);
      }
      return;
    }
    // GFM 任务列表 checkbox
    if (!onCommit) return;
    if (t.tagName !== 'INPUT') return;
    const input = t as HTMLInputElement;
    if (input.type !== 'checkbox') return;
    const raw = input.dataset['taskIndex'];
    if (raw === undefined) return;
    const idx = Number(raw);
    if (!Number.isFinite(idx) || idx < 0) return;
    e.preventDefault();
    e.stopPropagation();
    const next = toggleMarkdownTask(markdown, idx);
    if (next !== markdown) onCommit(next);
  }

  // 进入编辑 —— 聚焦并全选，方便直接覆写占位文本。
  useEffect(() => {
    if (editing && taRef.current) {
      taRef.current.focus();
      taRef.current.select();
    }
  }, [editing]);

  // 编辑态 textarea 跟内容长高：
  //  - 每次 draft 改变 / 进入编辑时，把 textarea.height 重置为 auto 读取
  //    scrollHeight，再把 height 设为该值；textarea 自身 overflow:hidden，
  //    不出滚动条。
  //  - 把整张文本卡的高度（textarea.offsetTop + offsetHeight）经 onResize 反馈
  //    给 OverlayLayer，element.height 同步增长，bbox / 选择框跟着伸缩。
  useEffect(() => {
    if (!editing) return;
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
    if (onResize) {
      const fullH = ta.offsetTop + ta.offsetHeight;
      if (Math.abs(fullH - element.height) > 4) onResize(fullH);
    }
  }, [editing, draft, onResize, element.height]);

  // 编辑态切换时同步 draft —— 进入编辑时拷 markdown 为草稿；退出时不动。
  useEffect(() => {
    if (editing) setDraft(markdown);
    // 出场时不重置 draft，避免无谓的 setState 让组件再 re-render。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // 兜底入口：当组件已 mount 但 props 没传 editing 时，body 的内部
  // onDoubleClick 仍可直接进编辑（双 tap 触摸屏 / 无 pointer-capture 场景）。
  const beginEdit = (): void => {
    if (!onCommit) return;
    setDraft(markdown);
    onEditingChange?.(true);
  };
  const commit = (): void => {
    onEditingChange?.(false);
    if (onCommit && draft !== markdown) onCommit(draft);
  };
  const cancel = (): void => {
    onEditingChange?.(false);
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
          ref={(el) => (bodyRef.current = el)}
          className="ov-text__body ov-md"
          style={bodyStyle}
          onDoubleClick={beginEdit}
          onPointerDown={handleBodyPointerDown}
          onClick={handleBodyClick}
          // marked 输出来自本地白板数据，受信，M2 直接内联。
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <div
          ref={(el) => (bodyRef.current = el)}
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
