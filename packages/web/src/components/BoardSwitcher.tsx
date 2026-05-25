/**
 * BoardSwitcher —— 顶栏的 board 切换 / 新建 / 删除入口（PRD §4.2 多 board 中继）。
 *
 * 下拉菜单：
 *  - 列出 server 托管的所有 board，当前激活的高亮 + 「当前」标记
 *  - 点击其它 board → 改 URL `?board=<id>` 整页 reload
 *  - + 新建：弹窗输入名称 → POST /api/boards → reload 到新 board
 *  - 每行右侧「⋯」→ 删除（移到 _trash/）；不能删当前激活 / 不能删最后一个
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
      <div className="bs">
        <button
          type="button"
          className="btn btn--secondary bs__trigger"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          title="切换 / 新建 / 删除白板"
        >
          🗂 {current.name}
          <span className="bs__chev">▾</span>
        </button>
        {open ? (
          <>
            <div className="bs__backdrop" onClick={() => setOpen(false)} />
            <div className="bs__menu" role="menu">
              <div className="bs__menu-list">
                {boards.map((b) => {
                  const isCurrent = b.id === current.id;
                  return (
                    <div
                      key={b.id}
                      className={'bs__row' + (isCurrent ? ' bs__row--current' : '')}
                    >
                      <button
                        type="button"
                        className="bs__row-main"
                        title={b.dir}
                        disabled={isCurrent}
                        onClick={() => {
                          setOpen(false);
                          switchToBoard(b.id);
                        }}
                      >
                        <span className="bs__row-name">{b.name}</span>
                        {b.isDefault ? (
                          <span className="bs__row-tag">默认</span>
                        ) : null}
                        {isCurrent ? (
                          <span className="bs__row-tag bs__row-tag--current">当前</span>
                        ) : null}
                      </button>
                      <button
                        type="button"
                        className="bs__row-del"
                        title={
                          isCurrent
                            ? '不能删除当前激活的白板，请先切到其它白板'
                            : boards.length === 1
                              ? '至少要保留一个白板'
                              : `删除「${b.name}」（移入 _trash/）`
                        }
                        disabled={isCurrent || boards.length === 1}
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpen(false);
                          setPendingDelete(b);
                        }}
                      >
                        删除
                      </button>
                    </div>
                  );
                })}
              </div>
              <div className="bs__menu-foot">
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={() => {
                    setOpen(false);
                    setCreateOpen(true);
                  }}
                >
                  + 新建白板
                </button>
              </div>
            </div>
          </>
        ) : null}
      </div>
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
