/**
 * 文件系统树构造 —— 把场景的 region / folder / file 元素映射成目录树。
 *
 * 供 FolderPanel（侧边面板）/ FolderCard（画布上的文件夹元素展开态）/
 * 任何需要按目录层级浏览文件的 UI 共用。
 *
 * 设计：
 *  - 树节点保留对应元素 id（如果有），便于点击文件后调用
 *    `requestNavigateToElement(elementId)` 把画布视口定位到该文件卡。
 *  - region / folder 元素的路径都视为目录；空目录也建节点（保留 children=[]）。
 *  - 排序：文件夹在前 → 文件在后；同类按 localeCompare 名称排序。
 */
import type { Element } from '@board/core';

/** 目录树节点。 */
export interface FsNode {
  name: string;
  /** 相对 files/ 的完整路径。空字符串 = 根。 */
  path: string;
  kind: 'dir' | 'file';
  /** 对应场景元素 id（若有）。file 节点有；dir 节点若由 region/folder 元素
   *  生成则带 id；纯由 file 路径派生的目录段则无。 */
  elementId?: string;
  children: FsNode[];
}

/** 去掉路径首尾斜杠（normalize 用）。 */
export function trimSlashes(p: string): string {
  return p.replace(/^\/+|\/+$/g, '');
}

/** 按扩展名给文件挑个字形图标。 */
export function fileGlyph(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) {
    return '🖼';
  }
  if (ext === 'md') return '📝';
  if (ext === 'pdf') return '📄';
  if (ext === 'zip' || ext === 'tar' || ext === 'gz') return '🗜';
  if (ext === 'csv' || ext === 'tsv') return '📊';
  return '📄';
}

/** 从场景的 region / folder / file 元素构建完整目录树（根节点为「files/」根）。 */
export function buildFsTree(elements: Element[]): FsNode {
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

  // 第一轮 region / folder 元素 → 文件夹节点（保证空文件夹也出现在树里）
  // 并把 elementId 写到对应路径节点上（便于「点目录跳画布定位区域」）。
  for (const el of elements) {
    if (el.type !== 'region' && el.type !== 'folder') continue;
    const p = trimSlashes(el.path);
    if (!p) continue;
    const node = ensureDir(p.split('/'));
    // 同一路径可能既有 region 又有 folder（不常见），区域优先；后到的不覆盖。
    if (!node.elementId) node.elementId = el.id;
  }
  // 第二轮 file 元素 → 文件节点
  for (const el of elements) {
    if (el.type !== 'file') continue;
    const parts = trimSlashes(el.path).split('/');
    const name = parts[parts.length - 1] ?? '';
    if (!name) continue;
    const dir = ensureDir(parts.slice(0, -1));
    if (!dir.children.some((c) => c.kind === 'file' && c.name === name)) {
      dir.children.push({
        name,
        path: el.path,
        kind: 'file',
        elementId: el.id,
        children: [],
      });
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

/** 在树里按路径找节点（路径相对 files/ 根）；找不到返回 null。 */
export function findFsNode(root: FsNode, path: string): FsNode | null {
  const p = trimSlashes(path);
  if (!p) return root;
  const parts = p.split('/');
  let cur: FsNode | null = root;
  for (const part of parts) {
    if (!cur) return null;
    const next: FsNode | undefined = cur.children.find(
      (c) => c.kind === 'dir' && c.name === part,
    );
    if (!next) return null;
    cur = next;
  }
  return cur;
}

/** 统计一个节点子树下的文件数（含递归）。 */
export function countFiles(node: FsNode): number {
  if (node.kind === 'file') return 1;
  return node.children.reduce((sum, c) => sum + countFiles(c), 0);
}
