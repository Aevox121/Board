/**
 * 选中元素的变换手柄 —— 八向缩放手柄（四角 + 四边）+ 顶部旋转手柄。
 *
 * 渲染在卡槽（.ov-slot）层级、贴卡片边缘；卡槽若已旋转，手柄随之旋转。
 * 手柄默认透明，靠光标提示方向；旋转手柄是顶部一个可见圆点。
 * 指针事件逻辑由 OverlayLayer 实现，本组件只挂手柄并转发事件。
 */
import type { PointerEvent, PointerEventHandler } from 'react';

/** 变换手柄 API —— `onStart` 携带缩放手柄方向分量（hx/hy）；旋转独立一组。 */
export interface ResizeApi {
  onStart: (
    e: PointerEvent<HTMLDivElement>,
    hx: -1 | 0 | 1,
    hy: -1 | 0 | 1,
  ) => void;
  onMove: PointerEventHandler<HTMLDivElement>;
  onUp: PointerEventHandler<HTMLDivElement>;
  onCancel: PointerEventHandler<HTMLDivElement>;
  /** 旋转手柄按下 / 移动 / 抬起 / 取消 —— 不传则不渲染旋转手柄。 */
  onRotateStart?: (e: PointerEvent<HTMLDivElement>) => void;
  onRotateMove?: PointerEventHandler<HTMLDivElement>;
  onRotateUp?: PointerEventHandler<HTMLDivElement>;
  onRotateCancel?: PointerEventHandler<HTMLDivElement>;
}

/** 八向手柄方向表：dir 用于 CSS 定位，hx/hy 为缩放方向分量。 */
const HANDLES: ReadonlyArray<{
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

/** 渲染一组变换手柄（八向缩放 + 可选旋转）。 */
export function ResizeHandles({
  api,
  rotatable = false,
}: {
  api: ResizeApi;
  /** 是否渲染顶部旋转手柄（区域等不可旋转元素传 false）。 */
  rotatable?: boolean;
}): JSX.Element {
  return (
    <>
      {HANDLES.map((h) => (
        <div
          key={h.dir}
          className={`ov-rz ov-rz--${h.dir}`}
          onPointerDown={(e) => api.onStart(e, h.hx, h.hy)}
          onPointerMove={api.onMove}
          onPointerUp={api.onUp}
          onPointerCancel={api.onCancel}
        />
      ))}
      {rotatable && api.onRotateStart ? (
        <div
          className="ov-rotate"
          onPointerDown={api.onRotateStart}
          onPointerMove={api.onRotateMove}
          onPointerUp={api.onRotateUp}
          onPointerCancel={api.onRotateCancel}
          aria-label="旋转"
        />
      ) : null}
    </>
  );
}
