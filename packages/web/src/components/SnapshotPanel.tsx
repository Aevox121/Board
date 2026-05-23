/**
 * 存档点 / 复原面板 —— PRD §8.5 / specs/线框图与里程碑.md §4。
 *
 * 数据源：`meta.snapshots`（BoardContext.meta，由 /api/board 实时刷出）。
 * 操作：新建 / 复原 / 删除 都经 server HTTP，server 完成后广播
 * board-changed，App 自动 refetch 元数据使本面板刷新。
 */
import { useState } from 'react';
import { useBoard } from '../board/BoardContext';
import {
  createSnapshot as apiCreate,
  deleteSnapshotApi,
  restoreSnapshot as apiRestore,
} from '../server/client';
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
  const [confirm, setConfirm] = useState<{ id: string; name: string } | null>(
    null,
  );
  const disabled = connection !== 'connected';

  const onCreate = async (): Promise<void> => {
    const name = window.prompt('为存档点起个名字（可留空）：', '');
    if (name === null) return;
    setBusy('create');
    try {
      await apiCreate(name.trim() || null, actorId);
    } catch (err) {
      window.alert(`新建存档失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const onDelete = async (id: string, name: string): Promise<void> => {
    if (!window.confirm(`删除存档「${name}」？此操作不可撤销。`)) return;
    setBusy(id);
    try {
      await deleteSnapshotApi(id);
    } catch (err) {
      window.alert(`删除存档失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const onRestoreConfirm = async (): Promise<void> => {
    if (!confirm) return;
    const id = confirm.id;
    setBusy(id);
    setConfirm(null);
    try {
      await apiRestore(id, actorId);
    } catch (err) {
      window.alert(`复原失败：${err instanceof Error ? err.message : String(err)}`);
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
                onClick={() => setConfirm({ id: s.id, name: s.name })}
              >
                {busy === s.id ? '复原中…' : '复原'}
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                disabled={disabled || busy === s.id}
                onClick={() => onDelete(s.id, s.name)}
                title="删除存档"
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="sp-foot">
        <button
          type="button"
          className="btn btn--primary"
          disabled={disabled || busy === 'create'}
          onClick={onCreate}
        >
          {busy === 'create' ? '新建中…' : '+ 新建存档点'}
        </button>
      </div>

      {confirm && (
        <div className="sp-modal-backdrop" onClick={() => setConfirm(null)}>
          <div className="sp-modal" onClick={(e) => e.stopPropagation()}>
            <div className="sp-modal__title">复原到「{confirm.name}」？</div>
            <div className="sp-modal__body">
              当前状态会先自动存档，可再切回。
            </div>
            <div className="sp-modal__actions">
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => setConfirm(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={onRestoreConfirm}
              >
                复原
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
