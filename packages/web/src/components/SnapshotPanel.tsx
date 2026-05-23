/**
 * 存档点 / 复原面板 —— PRD §8.5 / specs/线框图与里程碑.md §4。
 *
 * 数据源：`meta.snapshots`（BoardContext.meta，由 /api/board 实时刷出）。
 * 操作：新建 / 复原 / 删除 都经 server HTTP，server 完成后广播
 * board-changed，App 自动 refetch 元数据使本面板刷新。
 */
import { useEffect, useRef, useState } from 'react';
import { useBoard } from '../board/BoardContext';
import {
  createSnapshot as apiCreate,
  deleteSnapshotApi,
  restoreSnapshot as apiRestore,
} from '../server/client';
import { ConfirmDialog } from './Dialog';
import { toast } from './toast';
import './SnapshotPanel.css';

/** 把 ISO 时间串显示为人类可读的「今天 HH:MM / 昨天 HH:MM / YYYY-MM-DD HH:MM」。 */
function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const now = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) return `今天 ${hh}:${mi}`;
    const yest = new Date(now);
    yest.setDate(yest.getDate() - 1);
    const isYest =
      d.getFullYear() === yest.getFullYear() &&
      d.getMonth() === yest.getMonth() &&
      d.getDate() === yest.getDate();
    if (isYest) return `昨天 ${hh}:${mi}`;
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
  } catch {
    return iso;
  }
}

export function SnapshotPanel(): JSX.Element {
  const { meta, connection, actorId } = useBoard();
  // 按时间倒序 —— 最新在前；本地深拷贝，避免修改 meta 引用。
  const list = [...meta.snapshots].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const [busy, setBusy] = useState<string | null>(null); // 当前正在进行的操作（id 或 'create'）
  // 复原 / 删除确认弹窗 —— kind 区分用途，name 用于文案
  const [confirm, setConfirm] = useState<
    | { kind: 'restore'; id: string; name: string }
    | { kind: 'delete'; id: string; name: string }
    | null
  >(null);
  // 新建表单 —— 替换原生 prompt，行内展开在面板底部
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState('');
  const nameInputRef = useRef<HTMLInputElement>(null);
  // 表单展开后聚焦输入框
  useEffect(() => {
    if (creating) nameInputRef.current?.focus();
  }, [creating]);

  const disabled = connection !== 'connected';

  const openCreate = (): void => {
    setDraftName('');
    setCreating(true);
  };

  const cancelCreate = (): void => {
    setCreating(false);
    setDraftName('');
  };

  const submitCreate = async (): Promise<void> => {
    if (busy === 'create') return;
    const name = draftName.trim();
    setBusy('create');
    try {
      await apiCreate(name || null, actorId);
      setCreating(false);
      setDraftName('');
    } catch (err) {
      toast.error(
        `新建存档失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusy(null);
    }
  };

  const onDeleteConfirm = async (): Promise<void> => {
    if (!confirm || confirm.kind !== 'delete') return;
    const id = confirm.id;
    setBusy(id);
    setConfirm(null);
    try {
      await deleteSnapshotApi(id);
    } catch (err) {
      toast.error(
        `删除存档失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusy(null);
    }
  };

  const onRestoreConfirm = async (): Promise<void> => {
    if (!confirm || confirm.kind !== 'restore') return;
    const id = confirm.id;
    setBusy(id);
    setConfirm(null);
    try {
      await apiRestore(id, actorId);
    } catch (err) {
      toast.error(`复原失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <aside className="sp">
      <div className="sp-head">
        <span className="sp-title">存档点</span>
        <span className="sp-sub">{list.length} 份</span>
      </div>
      <div className="sp-list">
        {list.length === 0 && (
          <div className="sp-empty">尚无存档点 —— 点下方按钮新建一份</div>
        )}
        {list.map((s) => (
          <div className="sp-item" key={s.id} title={`${s.id} · ${s.createdAt}`}>
            <div className="sp-item__head">
              <span className="sp-item__marker">{s.auto ? '◷' : '★'}</span>
              <span className="sp-item__name">{s.name}</span>
            </div>
            <div className="sp-item__meta">
              <span>{fmtTime(s.createdAt)}</span>
              <span className="sp-dot">·</span>
              <span>{s.createdBy}</span>
            </div>
            <div className="sp-item__actions">
              <button
                type="button"
                className="btn btn--secondary"
                disabled={disabled || busy === s.id}
                onClick={() =>
                  setConfirm({ kind: 'restore', id: s.id, name: s.name })
                }
              >
                {busy === s.id ? '复原中…' : '复原'}
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                disabled={disabled || busy === s.id}
                onClick={() =>
                  setConfirm({ kind: 'delete', id: s.id, name: s.name })
                }
                title="删除存档"
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="sp-foot">
        {creating ? (
          <div className="sp-newform" role="dialog" aria-label="新建存档点">
            <div className="sp-newform__title">新建存档点</div>
            <label className="sp-newform__label" htmlFor="sp-new-name">
              名称
              <span className="sp-newform__opt">选填</span>
            </label>
            <input
              id="sp-new-name"
              ref={nameInputRef}
              className="sp-newform__input"
              value={draftName}
              maxLength={64}
              placeholder="如：出发前定稿（留空则自动命名）"
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void submitCreate();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  cancelCreate();
                }
              }}
              disabled={busy === 'create'}
            />
            <div className="sp-newform__actions">
              <button
                type="button"
                className="sp-newform__btn"
                onClick={cancelCreate}
                disabled={busy === 'create'}
              >
                取消
              </button>
              <button
                type="button"
                className="sp-newform__btn sp-newform__btn--primary"
                onClick={() => void submitCreate()}
                disabled={busy === 'create'}
              >
                {busy === 'create' ? '新建中…' : '创建'}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="sp-newbtn"
            disabled={disabled}
            onClick={openCreate}
            title={
              disabled ? '未连接 board-server，不能建存档' : '新建一份手动存档点'
            }
          >
            <span aria-hidden="true">＋</span>
            <span>新建存档点</span>
          </button>
        )}
      </div>

      {confirm?.kind === 'restore' && (
        <ConfirmDialog
          title={`复原到「${confirm.name}」？`}
          body="当前状态会先自动存档，可再切回。"
          confirmLabel="复原"
          onConfirm={onRestoreConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm?.kind === 'delete' && (
        <ConfirmDialog
          title={`删除存档「${confirm.name}」？`}
          body="此操作不可撤销。被删除的存档文件夹会一并从磁盘上移除。"
          confirmLabel="删除"
          danger
          onConfirm={onDeleteConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}
    </aside>
  );
}
