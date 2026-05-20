/**
 * 建议卡片 —— 建议机制（PRD §7.3）的可视化呈现。
 *
 * 渲染一个 `suggestion` 元素：承载 Agent 对某个目标元素提议的新内容，并提供
 * 「同意 / 拒绝 / 描述」三个处理操作 —— 决策权在人手里。
 *  - 同意：用建议内容替换 / 新增到白板，建议元素移除。
 *  - 拒绝：删除建议元素，原件不变。
 *  - 描述：向 Agent 写一段反馈，建议元素保留，形成「建议 ↔ 反馈」回路。
 *
 * 三个操作经 server `/api/suggestions/*` 落盘并广播，本卡片随场景刷新而更新。
 * 建议卡与目标元素之间的连线由 OverlayLayer 统一绘制。
 */
import { useState } from 'react';
import { marked } from 'marked';
import type { SuggestionElement } from '@board/core';
import { useBoard } from '../board/BoardContext';
import { cardRotation } from './util';
import {
  acceptSuggestion,
  describeSuggestion,
  rejectSuggestion,
} from '../server/client';

export interface SuggestionCardProps {
  element: SuggestionElement;
}

/** suggestionType → 中文标签。 */
const TYPE_LABEL: Record<SuggestionElement['suggestionType'], string> = {
  replace: '替换',
  add: '新增',
};

export function SuggestionCard({ element }: SuggestionCardProps): JSX.Element {
  const { connection } = useBoard();
  const rotation = cardRotation(element.id);
  const [busy, setBusy] = useState(false);
  const [describing, setDescribing] = useState(false);
  const [draft, setDraft] = useState('');

  const online = connection === 'connected';
  const payload = element.payload;
  // payload 预览 —— MVP 阶段建议内容均为文本，渲染其 Markdown。
  const previewHtml =
    payload.type === 'text' && payload.markdown
      ? (marked.parse(payload.markdown) as string)
      : '';
  // 建议理由 —— 与可并入的 payload 严格分开，同意时不进入目标。
  const reasonText = element.reason?.trim() ?? '';

  /** 跑一个建议操作，统一处理 busy 与错误提示。 */
  async function run(fn: () => Promise<void>, what: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      // 成功后 server 广播 board-changed → SSE 刷新；本卡片随场景更新/移除。
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      window.alert(`${what}失败：${msg}`);
    } finally {
      setBusy(false);
    }
  }

  function onAccept(): void {
    void run(() => acceptSuggestion(element.id), '同意建议');
  }

  function onReject(): void {
    void run(() => rejectSuggestion(element.id), '拒绝建议');
  }

  function onSendDescribe(): void {
    const text = draft.trim();
    if (text === '') return;
    void run(async () => {
      await describeSuggestion(element.id, text);
      setDraft('');
      setDescribing(false);
    }, '描述建议');
  }

  return (
    <div
      className="ov-card ov-suggestion"
      style={{ transform: `rotate(${rotation}deg)` }}
      title={`建议（${TYPE_LABEL[element.suggestionType]}）`}
    >
      <div className="ov-suggestion__bar">
        <span className="ov-suggestion__tag" aria-hidden="true">
          💡 建议
        </span>
        <span className="ov-suggestion__type">
          {TYPE_LABEL[element.suggestionType]}
        </span>
        <span className="ov-suggestion__author">{element.authorId}</span>
      </div>

      <div className="ov-suggestion__body">
        {/* 提议内容 —— 同意后并入目标的纯内容 */}
        <div className="ov-suggestion__section">
          <div className="ov-suggestion__section-label">
            提议内容 · 同意后并入目标
          </div>
          {payload.type === 'text' && previewHtml ? (
            <div
              className="ov-md"
              // marked 输出来自本地白板数据，受信。
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          ) : (
            <div className="ov-suggestion__empty">
              提议{TYPE_LABEL[element.suggestionType]}为「{payload.type}」元素
            </div>
          )}
        </div>

        {/* 建议理由 —— 只展示，同意时不并入目标 */}
        {reasonText ? (
          <div className="ov-suggestion__reason">
            <span className="ov-suggestion__reason-label">
              💬 建议理由 · 不并入
            </span>
            <span className="ov-suggestion__reason-text">{reasonText}</span>
          </div>
        ) : null}

        {element.thread.length > 0 ? (
          <ul className="ov-suggestion__thread">
            {element.thread.map((m, i) => (
              <li key={i} className="ov-suggestion__msg">
                <span className="ov-suggestion__msg-by">{m.by}</span>
                {m.text}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {describing ? (
        <div className="ov-suggestion__describe">
          <textarea
            className="ov-suggestion__input"
            placeholder="写给 Agent：哪里不满意 / 想怎么改…"
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            // 阻止指针事件冒泡，textarea 内的选择/拖选不被外层吞掉。
            onPointerDown={(e) => e.stopPropagation()}
          />
          <div className="ov-suggestion__actions">
            <button
              type="button"
              className="ov-suggestion__btn ov-suggestion__btn--primary"
              disabled={busy || !online || draft.trim() === ''}
              onClick={onSendDescribe}
            >
              发送
            </button>
            <button
              type="button"
              className="ov-suggestion__btn"
              disabled={busy}
              onClick={() => setDescribing(false)}
            >
              取消
            </button>
          </div>
        </div>
      ) : (
        <div className="ov-suggestion__actions">
          <button
            type="button"
            className="ov-suggestion__btn ov-suggestion__btn--accept"
            disabled={busy || !online}
            onClick={onAccept}
            title={
              online
                ? '只把「提议内容」并入目标，建议理由不并入'
                : '需连接 board-server'
            }
          >
            同意
          </button>
          <button
            type="button"
            className="ov-suggestion__btn ov-suggestion__btn--reject"
            disabled={busy || !online}
            onClick={onReject}
            title={online ? '删除建议，原件不变' : '需连接 board-server'}
          >
            拒绝
          </button>
          <button
            type="button"
            className="ov-suggestion__btn"
            disabled={busy || !online}
            onClick={() => setDescribing(true)}
            title="向 Agent 写一段反馈"
          >
            描述
          </button>
        </div>
      )}
    </div>
  );
}
