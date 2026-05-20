/**
 * 区域卡片 —— DOM 覆盖层内渲染一个 `region` 元素（PRD §6.6 / 设计系统 §7.5）。
 *
 * 带边框的区域容器：头部显示 `label` + `description`，陶土橙浅底。
 *
 * 关于子文件：区域不做 DOM 嵌套。落在区域坐标范围内的文件元素，靠 z 顺序
 * 自然显示在区域之上（区域 z 通常较低）—— 由 OverlayLayer 按 z 扁平渲染。
 *
 * 交互（M2 增量3）：
 *  - 头部 `.ov-region__head` 是拖拽手柄 —— 拖动可移动整个区域（含其内文件）。
 *  - 右下角 `.ov-region__resize` 是缩放手柄 —— 拖动可调整区域大小。
 *  指针事件逻辑由 OverlayLayer 实现，本组件只负责挂载手柄并转发事件。
 *
 * `highlighted`：拖拽文件卡悬停到本区域上方时为 true —— 高亮边框提示落点。
 */
import type { PointerEventHandler } from 'react';
import type { RegionElement } from '@board/core';
import { cardRotation } from './util';

/** 一组指针事件处理器 —— 由 OverlayLayer 注入到拖拽 / 缩放手柄上。 */
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
  /** 右下角缩放手柄的指针事件处理器。 */
  resizeHandlers?: PointerHandlers;
}

export function RegionCard({
  element,
  highlighted = false,
  active = false,
  headerHandlers,
  resizeHandlers,
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
      {/* 右下角缩放手柄 */}
      <div
        className="ov-region__resize"
        title="拖动调整区域大小"
        {...resizeHandlers}
      />
    </div>
  );
}
