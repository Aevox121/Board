/**
 * 区域卡片 —— DOM 覆盖层内渲染一个 `region` 元素（PRD §6.6 / 设计系统 §7.5）。
 *
 * 带边框的区域容器：头部显示 `label` + `description`，陶土橙浅底。
 *
 * 关于子文件：区域不做 DOM 嵌套。落在区域坐标范围内的文件元素，靠 z 顺序
 * 自然显示在区域之上（区域 z 通常较低）—— 由 OverlayLayer 按 z 扁平渲染。
 *
 * `highlighted`：拖拽文件卡悬停到本区域上方时为 true —— 高亮边框提示落点。
 */
import type { RegionElement } from '@board/core';
import { cardRotation } from './util';

export interface RegionCardProps {
  element: RegionElement;
  /** 是否为当前拖拽落点所在区域（高亮提示）。 */
  highlighted?: boolean;
}

export function RegionCard({
  element,
  highlighted = false,
}: RegionCardProps): JSX.Element {
  const { label, description } = element;
  // 区域旋转幅度比卡片更小（大块容器，过度倾斜会显乱）—— 取一半。
  const rotation = cardRotation(element.id) * 0.5;

  return (
    <div
      className={`ov-card ov-region${highlighted ? ' ov-region--drop' : ''}`}
      style={{ transform: `rotate(${rotation}deg)` }}
      title={element.path}
    >
      <div className="ov-region__head">
        <span className="ov-region__label">{label || '未命名区域'}</span>
        {description ? (
          <span className="ov-region__desc">{description}</span>
        ) : null}
      </div>
      {/* 区域主体留白 —— 子文件靠 z 顺序叠在其上，此处不渲染子项。 */}
      <div className="ov-region__body" aria-hidden="true" />
    </div>
  );
}
