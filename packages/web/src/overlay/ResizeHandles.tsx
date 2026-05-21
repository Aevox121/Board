/**
 * 八向缩放手柄（四角 + 四边）—— 任意可缩放卡片共用（文件 / 文本 / 文件夹 / 区域）。
 *
 * 渲染在卡槽（.ov-slot）层级、贴卡片边缘。手柄默认透明，靠光标提示方向；
 * 右下角额外画一个可见斜抓纹作为「可缩放」的视觉入口。
 * 指针事件逻辑由 OverlayLayer 实现，本组件只挂手柄并转发事件。
 */
import type { PointerEvent, PointerEventHandler } from 'react';

/** 八向缩放 API —— `onStart` 携带手柄方向分量（hx/hy）。 */
export interface ResizeApi {
  onStart: (
    e: PointerEvent<HTMLDivElement>,
    hx: -1 | 0 | 1,
    hy: -1 | 0 | 1,
  ) => void;
  onMove: PointerEventHandler<HTMLDivElement>;
  onUp: PointerEventHandler<HTMLDivElement>;
  onCancel: PointerEventHandler<HTMLDivElement>;
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

/** 渲染一组八向缩放手柄。 */
export function ResizeHandles({ api }: { api: ResizeApi }): JSX.Element {
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
    </>
  );
}
