/**
 * 顶栏 —— 应用外壳的一部分（设计系统 §7.1）。
 *
 * 保持「干净的暖色 UI」：白色 `--c-surface` 表面、规整边框、无手绘质感。
 * 左侧白板名用手写体 `--font-hand`（设计系统允许的「手绘呼应」点缀，点到为止）。
 *
 * 右侧布局（M1 web ⇄ server 对接）：
 *  - 连接状态指示：「已连接 · <白板名>」/「离线」/「连接中…」。
 *  - 已连接模式：显示「保存」按钮（PUT /api/board 落盘）。
 *  - 始终保留「导入 / 导出 board.json」作为离线兜底。
 */
import { useState } from 'react';
import type { ConnectionMode } from '../board/BoardContext';
import './TopBar.css';

/** 「保存」按钮状态机。 */
export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export interface TopBarProps {
  boardName: string;
  onRename: (name: string) => void;
  onImport: () => void;
  onExport: () => void;
  /** 触发保存到 server（仅已连接模式有效）。 */
  onSave: () => void;
  /** 元素计数，仅作轻量状态提示。 */
  elementCount: number;
  /** 当前连接模式。 */
  connection: ConnectionMode;
  /** 是否正在进行启动连接探测（探测中显示「连接中…」）。 */
  probing: boolean;
  /** 「保存」按钮状态。 */
  saveState: SaveState;
}

/** 「保存」按钮在各状态下的文案。 */
const SAVE_LABEL: Record<SaveState, string> = {
  idle: '保存',
  saving: '保存中…',
  saved: '已保存',
  error: '重试保存',
};

export function TopBar({
  boardName,
  onRename,
  onImport,
  onExport,
  onSave,
  elementCount,
  connection,
  probing,
  saveState,
}: TopBarProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(boardName);

  const commitName = (): void => {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== boardName) {
      onRename(next);
    } else {
      setDraft(boardName);
    }
  };

  const connected = connection === 'connected';

  // 连接状态指示文案与样式修饰符。
  const statusText = probing
    ? '连接中…'
    : connected
      ? `已连接 · ${boardName}`
      : '离线';
  const statusModifier = probing
    ? 'topbar__status--probing'
    : connected
      ? 'topbar__status--connected'
      : 'topbar__status--offline';

  return (
    <header className="topbar">
      <div className="topbar__left">
        <span className="topbar__logo" aria-hidden="true">
          ✦
        </span>
        {editing ? (
          <input
            className="topbar__name-input"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitName();
              if (e.key === 'Escape') {
                setDraft(boardName);
                setEditing(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="topbar__name"
            title="点击重命名白板"
            onClick={() => {
              setDraft(boardName);
              setEditing(true);
            }}
          >
            {boardName}
          </button>
        )}
        <span className="topbar__meta">{elementCount} 个元素</span>
      </div>

      <div className="topbar__right">
        {/* 连接状态指示 —— 圆点 + 文案 */}
        <span
          className={`topbar__status ${statusModifier}`}
          title={
            connected
              ? '已连接到 board-server'
              : probing
                ? '正在探测 board-server'
                : '未连接 board-server，处于离线模式'
          }
        >
          <span className="topbar__status-dot" aria-hidden="true" />
          {statusText}
        </span>

        {/* 已连接模式：保存到 server */}
        {connected && (
          <button
            type="button"
            className="btn btn--primary"
            onClick={onSave}
            disabled={saveState === 'saving'}
          >
            {SAVE_LABEL[saveState]}
          </button>
        )}

        {/* 导入 / 导出始终保留作为离线兜底 */}
        <button type="button" className="btn btn--secondary" onClick={onImport}>
          导入 board.json
        </button>
        <button type="button" className="btn btn--secondary" onClick={onExport}>
          导出 board.json
        </button>
      </div>
    </header>
  );
}
