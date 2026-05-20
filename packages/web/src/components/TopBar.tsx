/**
 * 顶栏 —— 应用外壳的一部分（设计系统 §7.1）。
 *
 * 保持「干净的暖色 UI」：白色 `--c-surface` 表面、规整边框、无手绘质感。
 * 左侧白板名用手写体 `--font-hand`（设计系统允许的「手绘呼应」点缀，点到为止）；
 * 右侧两个动作按钮：导入 / 导出 board.json。
 */
import { useState } from 'react';
import './TopBar.css';

export interface TopBarProps {
  boardName: string;
  onRename: (name: string) => void;
  onImport: () => void;
  onExport: () => void;
  /** 元素计数，仅作轻量状态提示。 */
  elementCount: number;
}

export function TopBar({
  boardName,
  onRename,
  onImport,
  onExport,
  elementCount,
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
        <button type="button" className="btn btn--secondary" onClick={onImport}>
          导入 board.json
        </button>
        <button type="button" className="btn btn--primary" onClick={onExport}>
          导出 board.json
        </button>
      </div>
    </header>
  );
}
