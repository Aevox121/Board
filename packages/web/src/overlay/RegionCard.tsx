/**
 * 区域卡片 —— DOM 覆盖层内渲染一个 `region` 元素（PRD §6.6 / 设计系统 §7.5）。
 *
 * 带边框的区域容器：头部显示 `label` + `description`，陶土橙浅底。
 *
 * 交互（M2 增量3）：
 *  - 头部 `.ov-region__head` 是拖拽手柄 —— 拖动可移动整个区域（含其内文件）。
 *  - 四角 + 四边共 8 个缩放手柄 `.ov-region__rz--*` —— 任意方向调整区域大小。
 *  指针事件逻辑由 OverlayLayer 实现，本组件只负责挂载手柄并转发事件。
 *
 * `highlighted`：拖拽文件卡悬停到本区域上方时为 true —— 高亮边框提示落点。
 */
import type { PointerEvent, PointerEventHandler } from 'react';
import type { RegionElement } from '@board/core';
import { cardRotation } from './util';

/** 一组指针事件处理器 —— 由 OverlayLayer 注入到拖拽手柄上。 */
export interface PointerHandlers {
  onPointerDown: PointerEventHandler<HTMLDivElement>;
  onPointerMove: PointerEventHandler<HTMLDivElement>;
  onPointerUp: PointerEventHandler<HTMLDivElement>;
  onPointerCancel: PointerEventHandler<HTMLDivElement>;
}

/**
 * 区域八向缩放 API —— `onStart` 携带手柄方向分量（hx/hy），
 * move/up/cancel 为所有手柄共用。
 */
export interface RegionResizeApi {
  onStart: (
    e: PointerEvent<HTMLDivElement>,
    hx: -1 | 0 | 1,
    hy: -1 | 0 | 1,
  ) => void;
  onMove: PointerEventHandler<HTMLDivElement>;
  onUp: PointerEventHandler<HTMLDivElement>;
  onCancel: PointerEventHandler<HTMLDivElement>;
}

/** 八向缩放手柄方向表：dir 用于 CSS 定位，hx/hy 为缩放方向分量。 */
const RESIZE_HANDLES: ReadonlyArray<{
  dir: string;
  hx: -1 | 0 | 1;
  hy: -1 | 0 | 1;
}> = [
  { dir: 'nw', hx: -1, hy: -1 },
  { dir: 'n', hx: 0, hy: -1 },
  { dir: 'ne', hx: 1, hy: -1 },
  { dir: 'e', hx: 1, hy: 0 },
  { dir: 'se', hx: 1, hy: 1 },
  { dir: 's', hx: 0, hy: 1 },
  { dir: 'sw', hx: -1, hy: 1 },
  { dir: 'w', hx: -1, hy: 0 },
];

export interface RegionCardProps {
  element: RegionElement;
  /** 是否为当前拖拽落点所在区域（高亮提示）。 */
  highlighted?: boolean;
  /** 区域是否正被拖拽 / 缩放（影响光标等视觉态）。 */
  active?: boolean;
  /** 头部拖拽手柄的指针事件处理器。 */
  headerHandlers?: PointerHandlers;
  /** 八向缩放 API。 */
  resize?: RegionResizeApi;
}

export function RegionCard({
  element,
  highlighted = false,
  active = false,
  headerHandlers,
  resize,
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
      {/* 八向缩放手柄 —— 须渲染在头部之后，保证顶边手柄叠在头部之上 */}
      {resize
        ? RESIZE_HANDLES.map((h) => (
            <div
              key={h.dir}
              className={`ov-region__rz ov-region__rz--${h.dir}`}
              onPointerDown={(e) => resize.onStart(e, h.hx, h.hy)}
              onPointerMove={resize.onMove}
              onPointerUp={resize.onUp}
              onPointerCancel={resize.onCancel}
            />
          ))
        : null}
    </div>
  );
}
