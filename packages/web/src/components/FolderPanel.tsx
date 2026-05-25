/**
 * 文件结构面板 —— 把白板「背后的文件结构」按访达式三种视图呈现
 * （PRD §6.5 「展开 / 收起（树 / 列表 / 网格三种视图）」 + §6.8 文件管理器视图）。
 *
 * 三种 viewMode：
 *  - `tree` —— 全树展开 / 收起（原行为）
 *  - `list` —— Finder-list 风格：仅当前目录的直接子项 + 顶部路径面包屑
 *  - `grid` —— 同上但渲染为图标网格
 *
 * 数据取自内存场景：`region` / `folder` 元素 → 文件夹节点，`file` 元素 →
 * 文件节点。场景随 yjs ws 同步实时刷新，面板能即时反映拖拽后的最新结构。
 *
 * 交互：
 *  - tree 模式：点 caret 折/展，点目录行同样切换
 *  - list / grid 模式：点目录进入子目录，点面包屑跳到任意祖先
 *  - 任意模式：点文件 → `requestNavigateToElement(elementId)` 把画布视口
 *    居中到该文件卡（与 OutlinePanel 共用同一份导航请求）
 */
import { useMemo, useState } from 'react';
import { useBoard } from '../board/BoardContext';
import {
  buildFsTree,
  countFiles,
  fileGlyph,
  findFsNode,
  type FsNode,
} from '../board/fsTree';
import './FolderPanel.css';

type FpViewMode = 'tree' | 'list' | 'grid';

/** 递归渲染一个树节点（tree 模式）。 */
function TreeNodeView({
  node,
  depth,
  onNavigate,
}: {
  node: FsNode;
  depth: number;
  onNavigate: (elementId: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(true);
  const indent: React.CSSProperties = { paddingLeft: `${depth * 14 + 8}px` };

  if (node.kind === 'file') {
    return (
      <div
        className="fp-row fp-row--file"
        style={indent}
        title={node.path}
        onClick={() => node.elementId && onNavigate(node.elementId)}
      >
        <span className="fp-glyph" aria-hidden="true">
          {fileGlyph(node.name)}
        </span>
        <span className="fp-name">{node.name}</span>
      </div>
    );
  }

  return (
    <>
      <div
        className="fp-row fp-row--dir"
        style={indent}
        title={node.path}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="fp-caret" aria-hidden="true">
          {node.children.length > 0 ? (open ? '▾' : '▸') : '·'}
        </span>
        <span className="fp-glyph" aria-hidden="true">
          📁
        </span>
        <span className="fp-name">{node.name}</span>
        <span className="fp-count">{countFiles(node)}</span>
      </div>
      {open &&
        node.children.map((c) => (
          <TreeNodeView
            key={`${c.kind}:${c.path}:${c.name}`}
            node={c}
            depth={depth + 1}
            onNavigate={onNavigate}
          />
        ))}
    </>
  );
}

/** Finder list 模式：直接列出当前目录的子项 + 双击目录进入 / 单击文件跳画布。 */
function ListView({
  node,
  onEnterDir,
  onNavigate,
}: {
  node: FsNode;
  onEnterDir: (path: string) => void;
  onNavigate: (elementId: string) => void;
}): JSX.Element {
  if (node.children.length === 0) {
    return <div className="fp-empty">（空目录）</div>;
  }
  return (
    <div className="fp-list">
      {node.children.map((c) => {
        if (c.kind === 'dir') {
          return (
            <div
              key={`dir:${c.path}`}
              className="fp-row fp-row--dir"
              style={{ paddingLeft: '12px' }}
              title={c.path}
              onClick={() => onEnterDir(c.path)}
            >
              <span className="fp-caret" aria-hidden="true">
                ▸
              </span>
              <span className="fp-glyph" aria-hidden="true">
                📁
              </span>
              <span className="fp-name">{c.name}</span>
              <span className="fp-count">{countFiles(c)}</span>
            </div>
          );
        }
        return (
          <div
            key={`file:${c.path}:${c.name}`}
            className="fp-row fp-row--file"
            style={{ paddingLeft: '12px' }}
            title={c.path}
            onClick={() => c.elementId && onNavigate(c.elementId)}
          >
            <span className="fp-glyph" aria-hidden="true">
              {fileGlyph(c.name)}
            </span>
            <span className="fp-name">{c.name}</span>
          </div>
        );
      })}
    </div>
  );
}

/** 图标网格模式：图标 + 名字 + 计数。 */
function GridView({
  node,
  onEnterDir,
  onNavigate,
}: {
  node: FsNode;
  onEnterDir: (path: string) => void;
  onNavigate: (elementId: string) => void;
}): JSX.Element {
  if (node.children.length === 0) {
    return <div className="fp-empty">（空目录）</div>;
  }
  return (
    <div className="fp-grid">
      {node.children.map((c) => {
        const onClick = (): void => {
          if (c.kind === 'dir') onEnterDir(c.path);
          else if (c.elementId) onNavigate(c.elementId);
        };
        return (
          <button
            key={`${c.kind}:${c.path}:${c.name}`}
            type="button"
            className={
              'fp-tile' +
              (c.kind === 'dir' ? ' fp-tile--dir' : ' fp-tile--file')
            }
            onClick={onClick}
            title={c.path}
          >
            <span className="fp-tile__glyph" aria-hidden="true">
              {c.kind === 'dir' ? '📁' : fileGlyph(c.name)}
            </span>
            <span className="fp-tile__name">{c.name}</span>
            {c.kind === 'dir' ? (
              <span className="fp-tile__sub">{countFiles(c)} 项</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** 面包屑：根 / a / b / c —— 每段可点回退。 */
function Breadcrumb({
  path,
  onJump,
}: {
  path: string;
  onJump: (path: string) => void;
}): JSX.Element {
  const parts = path ? path.split('/') : [];
  return (
    <nav className="fp-crumb" aria-label="路径面包屑">
      <button
        type="button"
        className="fp-crumb__seg"
        onClick={() => onJump('')}
        title="返回根目录"
      >
        🏠
      </button>
      {parts.map((seg, i) => {
        const accPath = parts.slice(0, i + 1).join('/');
        const isLast = i === parts.length - 1;
        return (
          <span key={accPath} className="fp-crumb__step">
            <span className="fp-crumb__sep" aria-hidden="true">
              /
            </span>
            {isLast ? (
              <span className="fp-crumb__current">{seg}</span>
            ) : (
              <button
                type="button"
                className="fp-crumb__seg"
                onClick={() => onJump(accPath)}
                title={`回到 ${accPath}`}
              >
                {seg}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

/** 文件结构侧边面板。 */
export function FolderPanel(): JSX.Element {
  const { scene, meta, requestNavigateToElement } = useBoard();

  const tree = useMemo(() => buildFsTree(scene.elements), [scene.elements]);
  const fileCount = useMemo(
    () => scene.elements.filter((e) => e.type === 'file').length,
    [scene.elements],
  );

  const [viewMode, setViewMode] = useState<FpViewMode>('tree');
  // 仅 list / grid 模式用：当前所在的子目录（相对 files/ 根）；'' = 根。
  const [currentPath, setCurrentPath] = useState<string>('');
  const currentNode = useMemo(
    () => findFsNode(tree, currentPath) ?? tree,
    [tree, currentPath],
  );

  // 切到 tree 模式时，currentPath 失去意义；保留状态以便切回 list/grid 还在原位。
  const onEnterDir = (path: string): void => setCurrentPath(path);

  return (
    <aside className="fp">
      <div className="fp-head">
        <span className="fp-title">文件结构</span>
        <span className="fp-sub">{fileCount} 个文件</span>
      </div>
      {/* 视图模式切换条 */}
      <div className="fp-modes" role="group" aria-label="视图模式">
        {(['tree', 'list', 'grid'] as const).map((m) => (
          <button
            key={m}
            type="button"
            className={
              'fp-mode-btn' + (viewMode === m ? ' fp-mode-btn--active' : '')
            }
            onClick={() => setViewMode(m)}
            title={m === 'tree' ? '树视图' : m === 'list' ? '列表视图' : '网格视图'}
            aria-pressed={viewMode === m}
          >
            {m === 'tree' ? '🌳 树' : m === 'list' ? '☰ 列表' : '⊞ 网格'}
          </button>
        ))}
      </div>

      <div className="fp-tree">
        {viewMode === 'tree' ? (
          <>
            <div className="fp-root" title={`${meta.name}.board / files`}>
              <span className="fp-glyph" aria-hidden="true">
                🗂
              </span>
              <span className="fp-name">{meta.name}</span>
              <span className="fp-root-tag">.board</span>
            </div>
            {tree.children
              .filter((c) => c.kind === 'dir')
              .map((c) => (
                <TreeNodeView
                  key={`dir:${c.path}`}
                  node={c}
                  depth={1}
                  onNavigate={requestNavigateToElement}
                />
              ))}
            {tree.children.some((c) => c.kind === 'file') && (
              <div className="fp-section">收件区 · 根目录</div>
            )}
            {tree.children
              .filter((c) => c.kind === 'file')
              .map((c) => (
                <TreeNodeView
                  key={`file:${c.name}`}
                  node={c}
                  depth={1}
                  onNavigate={requestNavigateToElement}
                />
              ))}
            {tree.children.length === 0 && (
              <div className="fp-empty">白板内暂无文件</div>
            )}
          </>
        ) : (
          <>
            <Breadcrumb path={currentPath} onJump={setCurrentPath} />
            {viewMode === 'list' ? (
              <ListView
                node={currentNode}
                onEnterDir={onEnterDir}
                onNavigate={requestNavigateToElement}
              />
            ) : (
              <GridView
                node={currentNode}
                onEnterDir={onEnterDir}
                onNavigate={requestNavigateToElement}
              />
            )}
          </>
        )}
      </div>
      <div className="fp-foot">
        画布同步刷新 · 点文件即跳视口
      </div>
    </aside>
  );
}
