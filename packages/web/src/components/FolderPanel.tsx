/**
 * 文件结构面板 —— 把白板「背后的文件结构」以目录树呈现，便于调试
 * 画布 ⇄ 文件系统的同步（PRD §6.8「文件管理器视图」的轻量调试版）。
 *
 * 数据取自内存场景：`region` / `folder` 元素 → 文件夹节点，`file` 元素 →
 * 文件节点；路径不含分隔符的文件归入「收件区」（files/ 根）。场景随 SSE
 * 实时刷新，故面板能即时反映拖拽移动文件后的最新结构。
 */
import { useMemo, useState } from 'react';
import type { Element } from '@board/core';
import { useBoard } from '../board/BoardContext';
import './FolderPanel.css';

/** 目录树节点。 */
interface FsNode {
  name: string;
  /** 相对 files/ 的完整路径。 */
  path: string;
  kind: 'dir' | 'file';
  children: FsNode[];
}

/** 按扩展名给文件挑个字形图标。 */
function fileGlyph(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) {
    return '🖼';
  }
  if (ext === 'md') return '📝';
  if (ext === 'pdf') return '📄';
  if (ext === 'zip' || ext === 'tar' || ext === 'gz') return '🗜';
  return '📄';
}

/** 去掉路径首尾斜杠。 */
function trimSlashes(p: string): string {
  return p.replace(/^\/+|\/+$/g, '');
}

/** 从场景的 region / folder / file 元素构建目录树。 */
function buildTree(elements: Element[]): FsNode {
  const root: FsNode = { name: '', path: '', kind: 'dir', children: [] };

  /** 沿路径段逐层确保（创建）文件夹节点，返回最深一层节点。 */
  function ensureDir(parts: string[]): FsNode {
    let node = root;
    let acc = '';
    for (const part of parts) {
      if (!part) continue;
      acc = acc ? `${acc}/${part}` : part;
      let child = node.children.find(
        (c) => c.kind === 'dir' && c.name === part,
      );
      if (!child) {
        child = { name: part, path: acc, kind: 'dir', children: [] };
        node.children.push(child);
      }
      node = child;
    }
    return node;
  }

  // region / folder 元素 → 文件夹节点（保证空文件夹也出现在树里）
  for (const el of elements) {
    if (el.type === 'region' || el.type === 'folder') {
      const p = trimSlashes(el.path);
      if (p) ensureDir(p.split('/'));
    }
  }
  // file 元素 → 文件节点
  for (const el of elements) {
    if (el.type !== 'file') continue;
    const parts = trimSlashes(el.path).split('/');
    const name = parts[parts.length - 1] ?? '';
    if (!name) continue;
    const dir = ensureDir(parts.slice(0, -1));
    if (!dir.children.some((c) => c.kind === 'file' && c.name === name)) {
      dir.children.push({ name, path: el.path, kind: 'file', children: [] });
    }
  }

  // 排序：文件夹在前，其次按名称
  const sortRec = (n: FsNode): void => {
    n.children.sort((a, b) =>
      a.kind !== b.kind
        ? a.kind === 'dir'
          ? -1
          : 1
        : a.name.localeCompare(b.name),
    );
    n.children.forEach(sortRec);
  };
  sortRec(root);
  return root;
}

/** 统计一个节点子树下的文件数。 */
function countFiles(node: FsNode): number {
  if (node.kind === 'file') return 1;
  return node.children.reduce((sum, c) => sum + countFiles(c), 0);
}

/** 递归渲染一个树节点。 */
function TreeNodeView({
  node,
  depth,
}: {
  node: FsNode;
  depth: number;
}): JSX.Element {
  const [open, setOpen] = useState(true);
  const indent: React.CSSProperties = { paddingLeft: `${depth * 14 + 8}px` };

  if (node.kind === 'file') {
    return (
      <div className="fp-row fp-row--file" style={indent} title={node.path}>
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
          />
        ))}
    </>
  );
}

/** 文件结构侧边面板。 */
export function FolderPanel(): JSX.Element {
  const { scene, meta } = useBoard();

  const tree = useMemo(() => buildTree(scene.elements), [scene.elements]);
  const fileCount = useMemo(
    () => scene.elements.filter((e) => e.type === 'file').length,
    [scene.elements],
  );

  // 顶层：区域 / 文件夹节点 + 收件区（根目录）文件
  const topDirs = tree.children.filter((c) => c.kind === 'dir');
  const inboxFiles = tree.children.filter((c) => c.kind === 'file');

  return (
    <aside className="fp">
      <div className="fp-head">
        <span className="fp-title">文件结构</span>
        <span className="fp-sub">{fileCount} 个文件</span>
      </div>
      <div className="fp-tree">
        <div className="fp-root" title={`${meta.name}.board / files`}>
          <span className="fp-glyph" aria-hidden="true">
            🗂
          </span>
          <span className="fp-name">{meta.name}</span>
          <span className="fp-root-tag">.board</span>
        </div>

        {topDirs.map((c) => (
          <TreeNodeView key={`dir:${c.path}`} node={c} depth={1} />
        ))}

        {inboxFiles.length > 0 && (
          <div className="fp-section">收件区 · 根目录</div>
        )}
        {inboxFiles.map((c) => (
          <TreeNodeView key={`file:${c.name}`} node={c} depth={1} />
        ))}

        {tree.children.length === 0 && (
          <div className="fp-empty">白板内暂无文件</div>
        )}
      </div>
      <div className="fp-foot">画布拖拽移动文件后，本面板实时刷新</div>
    </aside>
  );
}
