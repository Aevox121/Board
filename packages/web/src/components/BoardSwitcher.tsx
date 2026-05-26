/**
 * BoardSwitcher —— 顶栏的"白板管理"入口（PRD §4.2 多 board 中继）。
 *
 * 触发：顶栏 logo 后的按钮显示当前 board 名 + 「🗂 管理」chip。
 *
 * 打开后是一个**全屏模态管理页**（不是下拉）：
 *  - 网格卡片化展示 server 托管的所有 board
 *  - 每个卡片显示名称 / 路径 / 创建 / 更新时间 / 「当前」「默认」标签
 *  - 点卡片切换（改 URL `?board=<id>` 整页 reload）
 *  - 右上 × 删除（confirm 后 → _trash/）；不能删当前激活 / 不能删最后一个
 *  - 顶部「+ 新建白板」按钮 + 关闭按钮
 *
 * 静默隐藏条件：listBoards() 返空数组（server 没开启管理端点 / 公网部署
 * 关掉管理端点 / 网络断）。
 */
import { useEffect, useRef, useState } from 'react';
import { activeBoardId } from '../server/boardSession';
import {
  createBoard,
  deleteBoard,
  listBoards,
  switchToBoard,
  type BoardSummary,
} from '../server/boardsApi';
import { toast } from './toast';
import { ConfirmDialog, PromptDialog } from './Dialog';
import './BoardSwitcher.css';

/** "几秒前 / N 分钟前 / N 小时前 / N 天前 / YYYY-MM-DD" 的相对时间。 */
function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  const s = Math.floor(diff / 1000);
  if (s < 60) return '刚刚';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return iso.slice(0, 10);
}

export function BoardSwitcher(): JSX.Element | null {
  const [boards, setBoards] = useState<BoardSummary[] | null>(null);
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<BoardSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 首次渲染拉一次列表；空数组 = 隐藏（未启用 / 鉴权拒绝）。
  useEffect(() => {
    void (async () => {
      const list = await listBoards();
      if (mountedRef.current) setBoards(list);
    })();
  }, []);

  // 打开下拉时再刷新一次 —— 用户可能在另一个 tab 里建过 board。
  useEffect(() => {
    if (!open) return;
    void (async () => {
      const list = await listBoards();
      if (mountedRef.current) setBoards(list);
    })();
  }, [open]);

  // Escape 关闭模态 —— 必须在所有早返之前调用（React Hooks 规则）。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (boards === null || boards.length === 0) return null;

  const activeId = activeBoardId();
  // null = 走默认 board；找出 isDefault 的那条作为"当前"
  const current =
    boards.find((b) => (activeId === null ? b.isDefault : b.id === activeId)) ??
    boards[0]!;

  async function handleCreate(name: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const next = await createBoard(name.trim());
      toast.success(`已创建白板「${next.name}」`);
      setCreateOpen(false);
      // reload 到新 board
      switchToBoard(next.id);
    } catch (err) {
      toast.error(`创建失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  async function handleDelete(target: BoardSummary): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await deleteBoard(target.id);
      toast.success(`已删除「${target.name}」（已移入 _trash/）`);
      setPendingDelete(null);
      // 删的是当前激活的 → reload 到默认 board；否则就地刷新列表
      if (target.id === current.id) {
        switchToBoard(null);
      } else {
        const list = await listBoards();
        if (mountedRef.current) setBoards(list);
      }
    } catch (err) {
      toast.error(`删除失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn btn--secondary bs__trigger"
        onClick={() => setOpen(true)}
        title="打开白板管理页（切换 / 新建 / 删除）"
      >
        <span className="bs__trigger-name">🗂 {current.name}</span>
        <span className="bs__trigger-chip">管理</span>
      </button>
      {open ? (
        <>
          <div
            className="bs__modal-backdrop"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div
            className="bs__modal"
            role="dialog"
            aria-modal="true"
            aria-label="白板管理"
          >
            <header className="bs__modal-head">
              <h2 className="bs__modal-title">我的白板</h2>
              <span className="bs__modal-count">{boards.length} 个</span>
              <div className="bs__modal-actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => setCreateOpen(true)}
                >
                  + 新建白板
                </button>
                <button
                  type="button"
                  className="bs__modal-close"
                  onClick={() => setOpen(false)}
                  aria-label="关闭"
                  title="关闭（Esc）"
                >
                  ✕
                </button>
              </div>
            </header>
            <div className="bs__grid">
              {boards.map((b) => {
                const isCurrent = b.id === current.id;
                const cantDelete = isCurrent || boards.length === 1;
                return (
                  <div
                    key={b.id}
                    className={
                      'bs__card' + (isCurrent ? ' bs__card--current' : '')
                    }
                  >
                    <button
                      type="button"
                      className="bs__card-main"
                      disabled={isCurrent}
                      title={
                        isCurrent
                          ? '当前正在编辑这个白板'
                          : `进入「${b.name}」`
                      }
                      onClick={() => {
                        setOpen(false);
                        switchToBoard(b.id);
                      }}
                    >
                      <div className="bs__card-head">
                        <span className="bs__card-name">{b.name}</span>
                        <span className="bs__card-tags">
                          {b.isDefault ? (
                            <span className="bs__tag">默认</span>
                          ) : null}
                          {isCurrent ? (
                            <span className="bs__tag bs__tag--current">
                              当前
                            </span>
                          ) : null}
                        </span>
                      </div>
                      <div className="bs__card-meta">
                        <div className="bs__card-dir" title={b.dir}>
                          {b.dir}
                        </div>
                        <div className="bs__card-time">
                          <span>更新 {relativeTime(b.updatedAt)}</span>
                          <span className="bs__card-dot">·</span>
                          <span>创建 {relativeTime(b.createdAt)}</span>
                        </div>
                      </div>
                    </button>
                    <button
                      type="button"
                      className="bs__card-del"
                      disabled={cantDelete}
                      title={
                        isCurrent
                          ? '不能删除当前激活的白板，请先切到其它白板'
                          : boards.length === 1
                            ? '至少要保留一个白板'
                            : `删除「${b.name}」（移入 _trash/）`
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        setPendingDelete(b);
                      }}
                      aria-label={`删除 ${b.name}`}
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
            <footer className="bs__modal-foot">
              新建落点由 server 控制（启动时第一个 board 的父目录 /
              <code>BOARDS_ROOT</code> 环境变量）；删除是软删，可在
              <code>_trash/</code> 找回。
            </footer>
          </div>
        </>
      ) : null}
      {createOpen ? (
        <PromptDialog
          title="新建白板"
          body="名称中不允许 / \ : * ? &quot; &lt; &gt; |，最多 64 字"
          label="白板名称"
          placeholder="如：旅行计划"
          required
          confirmLabel="创建"
          onSubmit={(value) => {
            void handleCreate(value);
          }}
          onCancel={() => setCreateOpen(false)}
        />
      ) : null}
      {pendingDelete ? (
        <ConfirmDialog
          title={`删除「${pendingDelete.name}」？`}
          body={
            <>
              将把 .board 文件夹移入 <code>_trash/</code> 子目录，不真删，需要时可手动恢复。
              <br />
              <code>{pendingDelete.dir}</code>
            </>
          }
          confirmLabel="删除"
          danger
          onConfirm={() => {
            void handleDelete(pendingDelete);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      ) : null}
    </>
  );
}
