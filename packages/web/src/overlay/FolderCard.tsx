/**
 * 文件夹卡片 —— DOM 覆盖层内渲染一个 `folder` 元素（PRD §6.5 / 设计系统 §7.4）。
 *
 * 本增量只做收起态：卡片显示文件夹名 + 文件夹图标。
 * 展开（类访达浏览子项）属于后续增量，本次不做。
 */
import type { FolderElement } from '@board/core';
import { cardRotation, fileBaseName } from './util';

export interface FolderCardProps {
  element: FolderElement;
}

export function FolderCard({ element }: FolderCardProps): JSX.Element {
  const name = fileBaseName(element.path);
  const rotation = cardRotation(element.id);

  return (
    <div
      className="ov-card ov-folder"
      style={{ transform: `rotate(${rotation}deg)` }}
      title={element.path}
    >
      <span className="ov-folder__glyph" aria-hidden="true">
        📁
      </span>
      <span className="ov-folder__name">{name || '未命名文件夹'}</span>
    </div>
  );
}
