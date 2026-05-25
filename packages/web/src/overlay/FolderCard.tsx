/**
 * 文件夹卡片 —— DOM 覆盖层内渲染一个 `folder` 元素（PRD §6.5 / 设计系统 §7.4）。
 *
 * 两个形态：
 *  - 收起态（`element.expanded === false`）：手绘 chip，仅显示文件夹图标 +
 *    名字 + 子项计数。
 *  - 展开态（`element.expanded === true`）：类访达内联浏览，按 viewMode
 *    渲染为 列表 / 网格 / 树。展开时支持子文件夹「下钻」（card 内本地
 *    `subPath` 状态），文件点击即跳画布视口到对应卡片
 *    （`requestNavigateToElement`）。
 *
 * 数据：
 *  - 展开态需要场景全树才能渲染子项 —— `useBoard()` 取 scene 后构建 fsTree
 *    再按 `element.path / subPath` 取子节点。
 *  - 切换 `expanded` / `viewMode` 经父层注入的 `onToggleExpanded` /
 *    `onChangeViewMode` 写回元素字段（OverlayLayer.replaceScene）。
 */
import { useMemo, useState } from 'react';
import type { FolderElement } from '@board/core';
import { useBoard } from '../board/BoardContext';
import {
  buildFsTree,
  countFiles,
  fileGlyph,
  findFsNode,
  trimSlashes,
  type FsNode,
} from '../board/fsTree';
import { cardRotation, fileBaseName } from './util';

export interface FolderCardProps {
  element: FolderElement;
  /** 切换 `expanded`；不传则不渲染 chevron / 不可展开。 */
  onToggleExpanded?: () => void;
  /** 切换 `viewMode`；不传则不渲染视图切换条。 */
  onChangeViewMode?: (mode: FolderElement['viewMode']) => void;
}

export function FolderCard({
  element,
  onToggleExpanded,
  onChangeViewMode,
}: FolderCardProps): JSX.Element {
  const name = fileBaseName(element.path) || '未命名文件夹';
  // 展开态去掉微旋转 —— 内部要承载子项列表，倾斜会让对齐很乱。
  const rotation = element.expanded ? 0 : cardRotation(element.id);

  // 收起态：原始 chip。
  if (!element.expanded) {
    return (
      <div
        className="ov-card ov-folder"
        style={{ transform: `rotate(${rotation}deg)` }}
        title={element.path}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {onToggleExpanded ? (
          <button
            type="button"
            className="ov-folder__chevron"
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpanded();
            }}
            onPointerDown={(e) => e.stopPropagation()}
            title="展开文件夹"
            aria-label="展开文件夹"
            aria-expanded={false}
          >
            ▶
          </button>
        ) : null}
        <span className="ov-folder__glyph" aria-hidden="true">
          📁
        </span>
        <span className="ov-folder__name">{name}</span>
      </div>
    );
  }

  return <FolderCardExpanded element={element} onToggle={onToggleExpanded} onMode={onChangeViewMode} />;
}

/**
 * 展开态独立子组件 —— 用 useBoard() 取场景全树。
 * （拆出来避免收起态也额外订阅 BoardContext。）
 */
function FolderCardExpanded({
  element,
  onToggle,
  onMode,
}: {
  element: FolderElement;
  onToggle?: () => void;
  onMode?: (mode: FolderElement['viewMode']) => void;
}): JSX.Element {
  const { scene, requestNavigateToElement } = useBoard();
  const name = fileBaseName(element.path) || '未命名文件夹';
  // 卡内本地下钻路径（相对 element.path），''  = 直接显示 element.path 子项
  const [subPath, setSubPath] = useState<string>('');

  const tree = useMemo(() => buildFsTree(scene.elements), [scene.elements]);
  const fullPath = subPath
    ? `${trimSlashes(element.path)}/${subPath}`
    : trimSlashes(element.path);
  const node = useMemo<FsNode | null>(
    () => findFsNode(tree, fullPath),
    [tree, fullPath],
  );

  const handleNavigate = (elementId: string): void => {
    requestNavigateToElement(elementId);
  };
  const handleEnter = (subDirPath: string): void => {
    // subDirPath 是相对 files/ 根的完整路径；转成相对 element.path 的
    const base = trimSlashes(element.path);
    if (base && subDirPath.startsWith(`${base}/`)) {
      setSubPath(subDirPath.slice(base.length + 1));
    } else if (base === subDirPath) {
      setSubPath('');
    } else {
      // 异常 —— 子节点不在自己路径下，忽略
    }
  };

  return (
    <div
      className={
        'ov-card ov-folder ov-folder--expanded ov-folder--mode-' + element.viewMode
      }
      style={{ transform: 'none' }}
      title={element.path}
      // 卡片内的指针操作不触发画布拖拽。
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="ov-folder__head">
        {onToggle ? (
          <button
            type="button"
            className="ov-folder__chevron"
            onClick={onToggle}
            title="收起文件夹"
            aria-label="收起文件夹"
            aria-expanded={true}
          >
            ▼
          </button>
        ) : null}
        <span className="ov-folder__glyph" aria-hidden="true">
          📂
        </span>
        <span className="ov-folder__name">{name}</span>
        {onMode ? (
          <div className="ov-folder__modes" role="group" aria-label="视图模式">
            {(['list', 'grid', 'tree'] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={
                  'ov-folder__mode-btn' +
                  (element.viewMode === m ? ' ov-folder__mode-btn--active' : '')
                }
                onClick={() => onMode(m)}
                title={m === 'list' ? '列表' : m === 'grid' ? '网格' : '树'}
                aria-pressed={element.viewMode === m}
              >
                {m === 'list' ? '☰' : m === 'grid' ? '⊞' : '🌳'}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {/* 面包屑：只有「下钻进子目录后」才出现 */}
      {subPath ? (
        <nav className="ov-folder__crumb" aria-label="子目录面包屑">
          <button
            type="button"
            className="ov-folder__crumb-seg"
            onClick={() => setSubPath('')}
            title={`回到 ${name}`}
          >
            {name}
          </button>
          {subPath.split('/').map((seg, i, arr) => {
            const accSub = arr.slice(0, i + 1).join('/');
            const isLast = i === arr.length - 1;
            return (
              <span key={accSub} className="ov-folder__crumb-step">
                <span className="ov-folder__crumb-sep">/</span>
                {isLast ? (
                  <span className="ov-folder__crumb-current">{seg}</span>
                ) : (
                  <button
                    type="button"
                    className="ov-folder__crumb-seg"
                    onClick={() => setSubPath(accSub)}
                    title={`回到 ${name}/${accSub}`}
                  >
                    {seg}
                  </button>
                )}
              </span>
            );
          })}
        </nav>
      ) : null}
      <div className="ov-folder__body">
        {node ? (
          element.viewMode === 'tree' ? (
            <FolderTreeView node={node} depth={0} onNavigate={handleNavigate} />
          ) : node.children.length === 0 ? (
            <div className="ov-folder__empty">（空目录）</div>
          ) : element.viewMode === 'grid' ? (
            <FolderGridView
              node={node}
              onEnterDir={handleEnter}
              onNavigate={handleNavigate}
            />
          ) : (
            <FolderListView
              node={node}
              onEnterDir={handleEnter}
              onNavigate={handleNavigate}
            />
          )
        ) : (
          <div className="ov-folder__empty">（路径不在白板中）</div>
        )}
      </div>
    </div>
  );
}

/** 树视图：递归展开，子目录可折/展，文件直接跳画布。 */
function FolderTreeView({
  node,
  depth,
  onNavigate,
}: {
  node: FsNode;
  depth: number;
  onNavigate: (id: string) => void;
}): JSX.Element {
  return (
    <div className="ov-folder__tree">
      {node.children.length === 0 ? (
        <div className="ov-folder__empty">（空目录）</div>
      ) : (
        node.children.map((c) => (
          <TreeRow
            key={`${c.kind}:${c.path}:${c.name}`}
            node={c}
            depth={depth}
            onNavigate={onNavigate}
          />
        ))
      )}
    </div>
  );
}

function TreeRow({
  node,
  depth,
  onNavigate,
}: {
  node: FsNode;
  depth: number;
  onNavigate: (id: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(depth < 1);
  const indent: React.CSSProperties = { paddingLeft: `${depth * 14 + 6}px` };
  if (node.kind === 'file') {
    return (
      <div
        className="ov-folder__row ov-folder__row--file"
        style={indent}
        title={node.path}
        onClick={() => node.elementId && onNavigate(node.elementId)}
      >
        <span className="ov-folder__row-glyph" aria-hidden="true">
          {fileGlyph(node.name)}
        </span>
        <span className="ov-folder__row-name">{node.name}</span>
      </div>
    );
  }
  return (
    <>
      <div
        className="ov-folder__row ov-folder__row--dir"
        style={indent}
        title={node.path}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="ov-folder__row-caret" aria-hidden="true">
          {node.children.length > 0 ? (open ? '▾' : '▸') : '·'}
        </span>
        <span className="ov-folder__row-glyph" aria-hidden="true">
          📁
        </span>
        <span className="ov-folder__row-name">{node.name}</span>
        <span className="ov-folder__row-count">{countFiles(node)}</span>
      </div>
      {open &&
        node.children.map((c) => (
          <TreeRow
            key={`${c.kind}:${c.path}:${c.name}`}
            node={c}
            depth={depth + 1}
            onNavigate={onNavigate}
          />
        ))}
    </>
  );
}

/** 列表视图：仅当前目录直接子项；点目录下钻、点文件跳画布。 */
function FolderListView({
  node,
  onEnterDir,
  onNavigate,
}: {
  node: FsNode;
  onEnterDir: (path: string) => void;
  onNavigate: (id: string) => void;
}): JSX.Element {
  return (
    <div className="ov-folder__list">
      {node.children.map((c) => {
        const onClick = (): void => {
          if (c.kind === 'dir') onEnterDir(c.path);
          else if (c.elementId) onNavigate(c.elementId);
        };
        return (
          <div
            key={`${c.kind}:${c.path}:${c.name}`}
            className={
              'ov-folder__row ov-folder__row--' +
              (c.kind === 'dir' ? 'dir' : 'file')
            }
            style={{ paddingLeft: '8px' }}
            title={c.path}
            onClick={onClick}
          >
            {c.kind === 'dir' ? (
              <span className="ov-folder__row-caret" aria-hidden="true">
                ▸
              </span>
            ) : null}
            <span className="ov-folder__row-glyph" aria-hidden="true">
              {c.kind === 'dir' ? '📁' : fileGlyph(c.name)}
            </span>
            <span className="ov-folder__row-name">{c.name}</span>
            {c.kind === 'dir' ? (
              <span className="ov-folder__row-count">{countFiles(c)}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** 网格视图：图标 + 名字 + 计数。 */
function FolderGridView({
  node,
  onEnterDir,
  onNavigate,
}: {
  node: FsNode;
  onEnterDir: (path: string) => void;
  onNavigate: (id: string) => void;
}): JSX.Element {
  return (
    <div className="ov-folder__grid">
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
              'ov-folder__tile' +
              (c.kind === 'dir' ? ' ov-folder__tile--dir' : ' ov-folder__tile--file')
            }
            onClick={onClick}
            title={c.path}
          >
            <span className="ov-folder__tile-glyph" aria-hidden="true">
              {c.kind === 'dir' ? '📁' : fileGlyph(c.name)}
            </span>
            <span className="ov-folder__tile-name">{c.name}</span>
            {c.kind === 'dir' ? (
              <span className="ov-folder__tile-sub">{countFiles(c)} 项</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
