/**
 * 评论浮窗 —— 点击元素评论角标弹出（PRD §8.4）。
 *
 * 显示元素 `comments` 列表：每条评论的作者头像 + 名字 + 时间 + 文本，
 * 文本中的 `@xxx` 渲染为陶土橙 chip（参与者名称 / id 匹配则高亮）。
 *
 * 操作：
 *  - 单条「✓ 解决」/「↺ 重开」按钮切换 `resolved` 字段
 *  - 已解决的条目灰显 + 顶部 chip 标记
 *  - 底部输入框 + 「发送」按钮，回车 / Ctrl+Enter 提交
 *
 * 写回：经 `onPatchComments(newList)` 上报；OverlayLayer 落入 Y.Doc 同步。
 * 不直接打 HTTP —— 与本层其它写操作（replaceScene）走同款路径。
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import type { ElementComment, Participant, ParticipantId } from '@board/core';
import './CommentPopover.css';

/** 把评论文本切成 chunk —— 普通文本 / 提及 chip。 */
type Chunk =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; raw: string; matched: Participant | null };

/** 解析 @xxx —— 与参与者名 / id 比对，匹配的填 matched。 */
function parseMentions(text: string, participants: Participant[]): Chunk[] {
  // 简化的 @ 匹配：以 @ 开头，跟一串非空白 / 非中文标点字符。
  const re = /@([^\s@,，。；;!?！？]+)/g;
  const out: Chunk[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      out.push({ kind: 'text', text: text.slice(last, m.index) });
    }
    const handle = m[1] ?? '';
    const matched =
      participants.find(
        (p) => p.id === handle || p.name === handle || p.id === `u_${handle}`,
      ) ?? null;
    out.push({ kind: 'mention', raw: m[0], matched });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    out.push({ kind: 'text', text: text.slice(last) });
  }
  return out;
}

/** 时间戳缩写：当天显示时分，跨天显示「月-日 时:分」。 */
function fmtTs(ts: string): string {
  try {
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const hm = `${d.getHours().toString().padStart(2, '0')}:${d
      .getMinutes()
      .toString()
      .padStart(2, '0')}`;
    if (sameDay) return hm;
    return `${d.getMonth() + 1}-${d.getDate()} ${hm}`;
  } catch {
    return ts;
  }
}

export interface CommentPopoverProps {
  /** 评论列表（按时间正序）。 */
  comments: ReadonlyArray<ElementComment>;
  /** 全部参与者，用于 @ 匹配 + 头像名字。 */
  participants: ReadonlyArray<Participant>;
  /** 当前用户 id —— 默认作为新评论的 `by`。 */
  actorId: ParticipantId;
  /** 把新评论列表写回元素（覆盖 element.comments）。 */
  onPatchComments: (next: ElementComment[]) => void;
  /** 关闭浮窗。 */
  onClose: () => void;
  /**
   * 浮窗 anchor 屏幕坐标（角标位置 + offset）。
   * 浮窗右上角对齐到此点向左下方展开。
   */
  anchorScreen: { x: number; y: number };
}

export function CommentPopover({
  comments,
  participants,
  actorId,
  onPatchComments,
  onClose,
  anchorScreen,
}: CommentPopoverProps): JSX.Element {
  const [draft, setDraft] = useState('');
  // 默认不显示已解决评论 —— 减少视觉杂讯；按钮可切。
  const [showResolved, setShowResolved] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 浮窗挂载时聚焦输入框，方便直接打字。
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Esc 关闭、点外部 backdrop 关闭。
  useEffect(() => {
    const onKey = (e: KeyboardEvent | globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const participantOf = useMemo(() => {
    const m = new Map<string, Participant>();
    for (const p of participants) m.set(p.id, p);
    return m;
  }, [participants]);

  const visible = showResolved ? comments : comments.filter((c) => !c.resolved);
  const resolvedCount = comments.filter((c) => c.resolved).length;

  const submit = (): void => {
    const t = draft.trim();
    if (!t) return;
    const next: ElementComment[] = [
      ...comments,
      { by: actorId, text: t, ts: new Date().toISOString() },
    ];
    onPatchComments(next);
    setDraft('');
  };

  const toggleResolved = (idx: number): void => {
    const next = comments.map((c, i) =>
      i === idx ? { ...c, resolved: !c.resolved } : c,
    );
    onPatchComments(next);
  };

  // 浮窗几何 —— 右上角对齐到 anchor，向左下方展开。
  const popoverStyle: CSSProperties = {
    left: anchorScreen.x - 320, // 浮窗宽 ≈ 320
    top: anchorScreen.y + 8,
  };

  return (
    <>
      <div className="cmt-backdrop" onPointerDown={onClose} />
      <div
        className="cmt-popover"
        style={popoverStyle}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="cmt-head">
          <span className="cmt-title">评论（{visible.length}）</span>
          {resolvedCount > 0 ? (
            <button
              type="button"
              className="cmt-toggle"
              onClick={() => setShowResolved((v) => !v)}
            >
              {showResolved ? '隐藏' : '显示'}已解决（{resolvedCount}）
            </button>
          ) : null}
          <button type="button" className="cmt-close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="cmt-list">
          {visible.length === 0 ? (
            <div className="cmt-empty">
              {comments.length === 0 ? '还没有评论' : '没有未解决的评论'}
            </div>
          ) : (
            visible.map((c, i) => {
              // 注意：visible.indexOf 在数组里可能不准（同时间戳冲突），取原 idx。
              const idx = comments.indexOf(c);
              const author = participantOf.get(c.by);
              const chunks = parseMentions(c.text, [...participants]);
              return (
                <div
                  key={`${c.by}-${c.ts}-${i}`}
                  className={'cmt-row' + (c.resolved ? ' cmt-row--resolved' : '')}
                >
                  <span
                    className="cmt-avatar"
                    style={{ background: author?.color || '#999' }}
                    title={author?.name || c.by}
                  >
                    {(author?.name || c.by).slice(0, 1)}
                  </span>
                  <div className="cmt-body">
                    <div className="cmt-meta">
                      <span className="cmt-by">{author?.name || c.by}</span>
                      <span className="cmt-ts">{fmtTs(c.ts)}</span>
                      {c.resolved ? (
                        <span className="cmt-tag">已解决</span>
                      ) : null}
                    </div>
                    <div className="cmt-text">
                      {chunks.map((ch, j) =>
                        ch.kind === 'text' ? (
                          <span key={j}>{ch.text}</span>
                        ) : (
                          <span
                            key={j}
                            className={
                              'cmt-mention' +
                              (ch.matched ? ' cmt-mention--matched' : '')
                            }
                            title={
                              ch.matched
                                ? `${ch.matched.name} (${ch.matched.id})`
                                : '未匹配到参与者'
                            }
                          >
                            {ch.raw}
                          </span>
                        ),
                      )}
                    </div>
                    <div className="cmt-actions">
                      <button
                        type="button"
                        className="cmt-resolve"
                        onClick={() => toggleResolved(idx)}
                      >
                        {c.resolved ? '↺ 重开' : '✓ 解决'}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
        <div className="cmt-form">
          <textarea
            ref={inputRef}
            className="cmt-input"
            placeholder="评论…  支持 @ 提及"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <button
            type="button"
            className="cmt-send"
            onClick={submit}
            disabled={!draft.trim()}
          >
            发送
          </button>
        </div>
      </div>
    </>
  );
}
