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
import { useRef, useState } from 'react';
import type { ConnectionMode } from '../board/BoardContext';
import './TopBar.css';

/** 「保存」按钮状态机。 */
export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export interface TopBarProps {
  boardName: string;
  onRename: (name: string) => void;
  onImport: () => void;
  onExport: () => void;
  /** 导出当前白板为图片（PNG / SVG）。 */
  onExportImage: (format: 'png' | 'svg') => void;
  /** 触发保存到 server（仅已连接模式有效）。 */
  onSave: () => void;
  /** 选文件上传到 files/（PRD §6.4）；仅已连接模式可用。 */
  onUploadFiles: (files: File[]) => void;
  /** 元素计数，仅作轻量状态提示。 */
  elementCount: number;
  /** 当前连接模式。 */
  connection: ConnectionMode;
  /** 是否正在进行启动连接探测（探测中显示「连接中…」）。 */
  probing: boolean;
  /** 「保存」按钮状态。 */
  saveState: SaveState;
  /** 文件结构面板是否展开。 */
  folderViewOpen: boolean;
  /** 切换文件结构面板。 */
  onToggleFolderView: () => void;
  /** 大纲 / 搜索面板是否展开。 */
  outlineViewOpen: boolean;
  /** 切换大纲 / 搜索面板。 */
  onToggleOutlineView: () => void;
  /** 存档点面板是否展开。 */
  snapshotViewOpen: boolean;
  /** 切换存档点面板。 */
  onToggleSnapshotView: () => void;
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
  onExportImage,
  onSave,
  onUploadFiles,
  elementCount,
  connection,
  probing,
  saveState,
  folderViewOpen,
  onToggleFolderView,
  outlineViewOpen,
  onToggleOutlineView,
  snapshotViewOpen,
  onToggleSnapshotView,
}: TopBarProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(boardName);
  // 「导出」下拉菜单开合。
  const [exportOpen, setExportOpen] = useState(false);
  // 隐藏 <input type="file" multiple>，点上传按钮即触发它。
  const fileInputRef = useRef<HTMLInputElement>(null);

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

        {/* 大纲 / 搜索面板开关（PRD §6.8） */}
        <button
          type="button"
          className={`btn btn--secondary${outlineViewOpen ? ' is-active' : ''}`}
          onClick={onToggleOutlineView}
          title="大纲 / 全局搜索（区域 → 卡片，按字段过滤）"
          aria-pressed={outlineViewOpen}
        >
          🗂 大纲 / 搜索
        </button>

        {/* 文件结构面板开关 */}
        <button
          type="button"
          className={`btn btn--secondary${folderViewOpen ? ' is-active' : ''}`}
          onClick={onToggleFolderView}
          title="切换文件结构面板（查看白板背后的文件目录）"
          aria-pressed={folderViewOpen}
        >
          📁 文件结构
        </button>

        {/* 存档点面板开关（PRD §8.5） */}
        <button
          type="button"
          className={`btn btn--secondary${snapshotViewOpen ? ' is-active' : ''}`}
          onClick={onToggleSnapshotView}
          title="存档点 / 一键复原（PRD §8.5）"
          aria-pressed={snapshotViewOpen}
        >
          📜 存档
        </button>
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

        {/* 上传文件（PRD §6.4）—— 仅已连接模式可用，落进 .board/files/ */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            const list = e.target.files;
            if (!list || list.length === 0) return;
            onUploadFiles(Array.from(list));
            // 重置 value 让同一文件可重复选择。
            e.target.value = '';
          }}
        />
        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => fileInputRef.current?.click()}
          disabled={!connected}
          title={connected ? '上传文件到白板（落进 files/）' : '需连接 board-server'}
        >
          ⤴ 上传文件
        </button>

        {/* 导入 / 导出始终保留作为离线兜底 */}
        <button type="button" className="btn btn--secondary" onClick={onImport}>
          导入 board.json
        </button>
        <div className="tb-export">
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => setExportOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={exportOpen}
          >
            导出 ▾
          </button>
          {exportOpen ? (
            <>
              <div
                className="tb-export__backdrop"
                onClick={() => setExportOpen(false)}
              />
              <div className="tb-export__menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setExportOpen(false);
                    onExport();
                  }}
                >
                  board.json
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setExportOpen(false);
                    onExportImage('png');
                  }}
                >
                  PNG 图片
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setExportOpen(false);
                    onExportImage('svg');
                  }}
                >
                  SVG 图片
                </button>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </header>
  );
}
