/**
 * 选择文件夹对话框 —— 在画布上创建一个 folder 元素时使用（PRD §6.5）。
 *
 * 体验：
 *  - 顶部展开列出场景里已有的 files/ 子文件夹（按目录树扁平化 + 缩进），
 *    点击一行即选中并回填路径输入框；
 *  - 底部输入框允许手动输入任意路径（也可在白板还没有该路径时先建后建）；
 *  - Enter / 主按钮提交；Esc / 遮罩 / 次按钮取消。
 *
 * 不去创建文件夹本身（不动 files/）—— 只在画布上添加一个指向该路径的
 * folder 元素；OverlayLayer 接收到 path 后把元素放到 click 落点。
 */
import { useMemo, useRef, useState, useEffect } from 'react';
import type { Element } from '@board/core';
import { Dialog } from '../components/Dialog';
import { buildFsTree, type FsNode } from '../board/fsTree';

export interface FolderPickDialogProps {
  /** 当前场景元素 —— 用于列出已有 files/ 子文件夹。 */
  elements: ReadonlyArray<Element>;
  /** 默认填充路径。 */
  defaultPath?: string;
  /** 确认时回调 —— `path` 已 trim 过、`/` 已规范、首尾斜杠去除。 */
  onConfirm: (path: string) => void;
  /** 取消（Esc / 遮罩 / 次按钮）。 */
  onCancel: () => void;
}

/** 把目录树展平为「带深度的 dir 列表」—— 跳过 file 节点。 */
function flattenDirs(
  node: FsNode,
  depth: number,
  out: Array<{ path: string; name: string; depth: number }>,
): void {
  for (const c of node.children) {
    if (c.kind !== 'dir') continue;
    out.push({ path: c.path, name: c.name, depth });
    flattenDirs(c, depth + 1, out);
  }
}

/** 规范化路径输入：`\` → `/`、去首尾 `/`、合并连续 `/`、去段两端空白。 */
function normalize(input: string): string {
  return input
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .join('/');
}

export function FolderPickDialog({
  elements,
  defaultPath = '',
  onConfirm,
  onCancel,
}: FolderPickDialogProps): JSX.Element {
  const [path, setPath] = useState(defaultPath);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, []);

  const dirs = useMemo(() => {
    const tree = buildFsTree(elements as Element[]);
    const out: Array<{ path: string; name: string; depth: number }> = [];
    flattenDirs(tree, 0, out);
    return out;
  }, [elements]);

  const trimmed = normalize(path);
  const disabled = trimmed.length === 0;

  const submit = (): void => {
    if (disabled) {
      inputRef.current?.focus();
      return;
    }
    onConfirm(trimmed);
  };

  return (
    <Dialog
      title="选择要放上画布的文件夹"
      width={420}
      onCancel={onCancel}
      primary={{ label: '加入画布', onClick: submit, disabled }}
      secondary={{ label: '取消', onClick: onCancel }}
    >
      <div className="bd-dialog__text">
        在画布上放置一个文件夹卡片，指向 <code>files/</code> 下的任意路径。
        卡片展开后可按 列表 / 网格 / 树 三种视图浏览其下子项；点子文件夹下钻、
        点文件跳画布。
      </div>
      {dirs.length > 0 ? (
        <div className="folder-pick__list" role="listbox">
          {dirs.map((d) => {
            const active = trimmed === d.path;
            return (
              <button
                key={d.path}
                type="button"
                role="option"
                aria-selected={active}
                className={
                  'folder-pick__row' +
                  (active ? ' folder-pick__row--active' : '')
                }
                style={{ paddingLeft: `${8 + d.depth * 14}px` }}
                onClick={() => setPath(d.path)}
                title={d.path}
              >
                <span className="folder-pick__row-glyph" aria-hidden="true">
                  📁
                </span>
                <span className="folder-pick__row-name">{d.name}</span>
                <span className="folder-pick__row-path">{d.path}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="bd-dialog__text" style={{ color: 'var(--c-ink-3)' }}>
          白板里还没有任何子文件夹，请在下方手输路径（也可指向尚未存在的目录）。
        </div>
      )}
      <label
        className="bd-dialog__label"
        htmlFor="folder-pick-path"
        style={{ marginTop: 'var(--space-3)' }}
      >
        相对 files/ 的路径
      </label>
      <input
        id="folder-pick-path"
        ref={inputRef}
        className="bd-dialog__input"
        value={path}
        maxLength={200}
        placeholder="例：路线/day1"
        onChange={(e) => setPath(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
      />
    </Dialog>
  );
}
