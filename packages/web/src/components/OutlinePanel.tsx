/**
 * 大纲面板 —— 把白板的「逻辑结构」以树呈现（PRD §6.8）。
 *
 * FolderPanel 是「文件系统视角」（folder/file 元素 → 目录树）；
 * OutlinePanel 是「白板视角」（区域 + 卡片元素的归属层级）：
 *  - 收件区（无 parentId 的卡片）+ 各区域（含嵌套）
 *  - 区域子节点 = 子区域 + 该区域内的卡片元素
 *  - 顶部搜索框 —— 跨字段过滤树（label / path / markdown / url / 描述等）
 *  - 点击行 = 把主视口跳到该元素（requestNavigateToElement）
 *
 * 数据驱动：仅读 scene；区域 / 元素增删改、远端同步都会自动重渲染。
 */
import { useMemo, useState } from 'react';
import type { Element, RegionElement } from '@board/core';
import { useBoard } from '../board/BoardContext';
import './OutlinePanel.css';

interface NodeBase {
  /** 显示用名称。 */
  label: string;
  /** 该节点对应的元素 id（点击跳转用）；区域节点也填，跳转到区域中心。 */
  elementId: string;
  /** 子节点；卡片节点为空数组。 */
  children: OutlineNode[];
}
interface RegionNode extends NodeBase {
  kind: 'region';
}
interface CardNode extends NodeBase {
  kind: 'card';
  elementType: Element['type'];
}
type OutlineNode = RegionNode | CardNode;

/** 取元素的展示标题 —— 按类型挑最有信息量的字段。 */
function elementTitle(el: Element): string {
  switch (el.type) {
    case 'region':
      return el.label || '未命名区域';
    case 'folder':
    case 'file':
      return el.path.split('/').pop() || el.path;
    case 'text': {
      const first = el.markdown.split(/\r?\n/).find((s) => s.trim());
      const t = (first ?? '').replace(/^[#>\s*-]+/, '').trim();
      return t.length > 0 ? (t.length > 40 ? `${t.slice(0, 40)}…` : t) : '空文本卡';
    }
    case 'shape':
      return el.label?.text || `图形（${el.shape}）`;
    case 'draw':
      return '手绘';
    case 'image':
      return el.path
        ? el.path.split('/').pop() || el.path
        : '图片';
    case 'embed':
      return el.url || '嵌入';
    case 'connector':
      return el.label?.text || '连线';
    case 'suggestion':
      return '建议';
  }
}

/** 该元素是否属于「卡片型」—— 在大纲里作为叶子节点出现。 */
function isOutlineLeaf(t: Element['type']): boolean {
  return (
    t === 'file' || t === 'folder' || t === 'text' || t === 'image' || t === 'embed'
  );
}

/** 构建大纲树。 */
function buildOutline(elements: ReadonlyArray<Element>): OutlineNode[] {
  // 区域的父子关系按 path 的层级 / parentId 推断。这里以 parentId 为准。
  const regions = elements.filter(
    (e): e is RegionElement => e.type === 'region',
  );
  const cardsByParent = new Map<string | null, Element[]>();
  for (const e of elements) {
    if (!isOutlineLeaf(e.type)) continue;
    const key = e.parentId ?? null;
    const arr = cardsByParent.get(key) ?? [];
    arr.push(e);
    cardsByParent.set(key, arr);
  }
  // 区域按 z 升序展示（顶部 = 底层背景区域）。
  regions.sort((a, b) => (a.z < b.z ? -1 : a.z > b.z ? 1 : 0));

  /** 递归装一个区域节点：子区域 + 该区域的卡片。 */
  function buildRegion(r: RegionElement): RegionNode {
    const subRegions = regions
      .filter((x) => x.parentId === r.id)
      .map(buildRegion);
    const cards = (cardsByParent.get(r.id) ?? []).map<CardNode>((c) => ({
      kind: 'card',
      label: elementTitle(c),
      elementId: c.id,
      elementType: c.type,
      children: [],
    }));
    cards.sort((a, b) => a.label.localeCompare(b.label));
    return {
      kind: 'region',
      label: elementTitle(r),
      elementId: r.id,
      children: [...subRegions, ...cards],
    };
  }

  const topRegions = regions.filter((r) => r.parentId == null).map(buildRegion);
  // 收件区 = parentId 为 null 的卡片。
  const inboxCards = (cardsByParent.get(null) ?? []).map<CardNode>((c) => ({
    kind: 'card',
    label: elementTitle(c),
    elementId: c.id,
    elementType: c.type,
    children: [],
  }));
  inboxCards.sort((a, b) => a.label.localeCompare(b.label));
  const inbox: RegionNode | null =
    inboxCards.length > 0
      ? {
          kind: 'region',
          label: '收件区',
          elementId: '__inbox__',
          children: inboxCards,
        }
      : null;

  return inbox ? [inbox, ...topRegions] : topRegions;
}

/** 全文搜索字段拼接 —— 把元素所有「可搜文本」并到一个串里。 */
function searchTextOf(el: Element): string {
  const parts: string[] = [el.id];
  switch (el.type) {
    case 'region':
      parts.push(el.label || '', el.description || '', el.path);
      break;
    case 'folder':
    case 'file':
      parts.push(el.path);
      break;
    case 'text':
      parts.push(el.markdown);
      break;
    case 'shape':
      parts.push(el.label?.text || '', el.shape);
      break;
    case 'image':
      parts.push(el.path || '');
      break;
    case 'embed':
      parts.push(el.url);
      break;
    case 'connector':
      parts.push(el.label?.text || '');
      break;
    default:
      break;
  }
  return parts.join(' ').toLowerCase();
}

/** 按关键词过滤场景，返回命中元素 id 集。 */
function searchHits(
  elements: ReadonlyArray<Element>,
  keyword: string,
): Set<string> {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return new Set();
  const hits = new Set<string>();
  for (const e of elements) {
    if (searchTextOf(e).includes(kw)) hits.add(e.id);
  }
  return hits;
}

/** 节点是否「命中保留」—— 自身命中或任一后代命中。 */
function nodeRetained(
  node: OutlineNode,
  hits: Set<string>,
): boolean {
  if (hits.has(node.elementId)) return true;
  return node.children.some((c) => nodeRetained(c, hits));
}

interface OutlineRowProps {
  node: OutlineNode;
  depth: number;
  /** 命中集（空表示无过滤，全部展开/显示）。 */
  hits: Set<string> | null;
  onJump: (id: string) => void;
}

function OutlineRow({
  node,
  depth,
  hits,
  onJump,
}: OutlineRowProps): JSX.Element | null {
  // 默认展开；带过滤时强制展开命中分支。
  const [openLocal, setOpenLocal] = useState(true);
  const open = hits ? true : openLocal;

  if (hits && !nodeRetained(node, hits)) return null;
  const indent: React.CSSProperties = { paddingLeft: `${depth * 14 + 8}px` };
  const selfHit = hits ? hits.has(node.elementId) : false;
  const hasChildren = node.children.length > 0;

  return (
    <>
      <div
        className={
          'op-row op-row--' +
          node.kind +
          (selfHit ? ' op-row--hit' : '') +
          (node.kind === 'card' ? ` op-row--card-${(node as CardNode).elementType}` : '')
        }
        style={indent}
        title={node.elementId}
        onClick={() => {
          if (hasChildren && node.kind === 'region') {
            // 区域行：折叠 / 展开。点击 elementId chip（右侧）才跳转 —— 见下方按钮。
            setOpenLocal((v) => !v);
          } else if (node.elementId && !node.elementId.startsWith('__')) {
            onJump(node.elementId);
          }
        }}
      >
        {hasChildren ? (
          <span className="op-caret" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
        ) : (
          <span className="op-caret op-caret--leaf" aria-hidden="true">
            ·
          </span>
        )}
        <span className="op-glyph" aria-hidden="true">
          {node.kind === 'region'
            ? node.elementId === '__inbox__'
              ? '📥'
              : '🗂'
            : glyphOf((node as CardNode).elementType)}
        </span>
        <span className="op-name">{node.label}</span>
        {node.kind === 'region' && !node.elementId.startsWith('__') ? (
          <button
            type="button"
            className="op-jump"
            title="跳转到该区域"
            onClick={(e) => {
              e.stopPropagation();
              onJump(node.elementId);
            }}
          >
            ↪
          </button>
        ) : null}
      </div>
      {open
        ? node.children.map((c) => (
            <OutlineRow
              key={c.elementId + ':' + c.kind}
              node={c}
              depth={depth + 1}
              hits={hits}
              onJump={onJump}
            />
          ))
        : null}
    </>
  );
}

function glyphOf(t: Element['type']): string {
  switch (t) {
    case 'file':
      return '📄';
    case 'folder':
      return '📁';
    case 'text':
      return '📝';
    case 'image':
      return '🖼';
    case 'embed':
      return '🔗';
    case 'shape':
      return '◇';
    case 'draw':
      return '✎';
    case 'connector':
      return '↗';
    case 'suggestion':
      return '💡';
    case 'region':
      return '🗂';
  }
}

export function OutlinePanel(): JSX.Element {
  const { scene, requestNavigateToElement } = useBoard();
  const [query, setQuery] = useState('');
  const tree = useMemo(() => buildOutline(scene.elements), [scene.elements]);
  const hits = useMemo(
    () => (query.trim() ? searchHits(scene.elements, query) : null),
    [scene.elements, query],
  );
  const hitCount = hits ? hits.size : 0;
  const totalCount = scene.elements.length;

  return (
    <aside className="op-panel" aria-label="大纲与搜索">
      <div className="op-head">
        <span className="op-title">大纲与搜索</span>
        <span className="op-stat">
          {query.trim() ? `${hitCount} / ${totalCount}` : totalCount}
        </span>
      </div>
      <div className="op-search">
        <input
          type="search"
          className="op-search__input"
          placeholder="搜索元素文本 / 文件名 / URL / 区域描述…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query ? (
          <button
            type="button"
            className="op-search__clear"
            onClick={() => setQuery('')}
            title="清空"
          >
            ×
          </button>
        ) : null}
      </div>
      <div className="op-tree">
        {tree.length === 0 ? (
          <div className="op-empty">空白板</div>
        ) : query.trim() && hitCount === 0 ? (
          <div className="op-empty">无匹配项</div>
        ) : (
          tree.map((n) => (
            <OutlineRow
              key={n.elementId + ':' + n.kind}
              node={n}
              depth={0}
              hits={hits}
              onJump={requestNavigateToElement}
            />
          ))
        )}
      </div>
    </aside>
  );
}
