/**
 * 区域卡片 —— DOM 覆盖层内渲染一个 `region` 元素（PRD §6.6 / 设计系统 §7.5）。
 *
 * 带边框的区域容器：头部显示 `label` + `description`，陶土橙浅底。
 *
 * 交互：头部 `.ov-region__head` 兼作拖拽手柄 —— 拖动可移动整个区域（含其内
 * 文件）。八向缩放手柄改由 OverlayLayer 在卡槽（.ov-slot）层级统一渲染
 * （见 ResizeHandles），与文件 / 文本 / 文件夹卡一致。
 *
 * `highlighted`：拖拽文件卡悬停到本区域上方时为 true —— 高亮边框提示落点。
 */
import type { PointerEventHandler } from 'react';
import type { RegionElement } from '@board/core';
import { cardRotation } from './util';

/** 一组指针事件处理器 —— 由 OverlayLayer 注入到拖拽手柄上。 */
export interface PointerHandlers {
  onPointerDown: PointerEventHandler<HTMLDivElement>;
  onPointerMove: PointerEventHandler<HTMLDivElement>;
  onPointerUp: PointerEventHandler<HTMLDivElement>;
  onPointerCancel: PointerEventHandler<HTMLDivElement>;
}

export interface RegionCardProps {
  element: RegionElement;
  /** 是否为当前拖拽落点所在区域（高亮提示）。 */
  highlighted?: boolean;
  /** 区域是否正被拖拽 / 缩放（影响光标等视觉态）。 */
  active?: boolean;
  /** 头部拖拽手柄的指针事件处理器。 */
  headerHandlers?: PointerHandlers;
}

export function RegionCard({
  element,
  highlighted = false,
  active = false,
  headerHandlers,
}: RegionCardProps): JSX.Element {
  const { label, description } = element;
  // 区域旋转幅度比卡片更小（大块容器，过度倾斜会显乱）—— 取一半。
  const rotation = cardRotation(element.id) * 0.5;

  const className =
    'ov-card ov-region' +
    (highlighted ? ' ov-region--drop' : '') +
    (active ? ' ov-region--active' : '');

  return (
    <div
      className={className}
      style={{ transform: `rotate(${rotation}deg)` }}
      title={element.path}
    >
      {/* 头部 —— 兼作拖拽手柄 */}
      <div className="ov-region__head" {...headerHandlers}>
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
