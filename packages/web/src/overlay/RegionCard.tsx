/**
 * 区域卡片 —— DOM 覆盖层内渲染一个 `region` 元素（PRD §6.6 / 设计系统 §7.5）。
 *
 * 带边框的区域容器：头部显示 `label` + `description`，陶土橙浅底。
 *
 * 交互：头部 `.ov-region__head` 兼作拖拽手柄 —— 拖动可移动整个区域（含其内
 * 文件）。八向缩放手柄改由 OverlayLayer 在卡槽（.ov-slot）层级统一渲染
 * （见 ResizeHandles），与文件 / 文本 / 文件夹卡一致。
 *
 * 软归属（PRD §8.3）：头部右侧显示归属徽标 —— 当前用户的区域=实色边框 +
 * 「我的区域」chip；他人的区域=该参与者颜色边框 + 「xxx 的区域」chip；
 * 无归属=默认陶土橙边 + 「公共区域」chip。仅做提示，不强制锁定。
 *
 * `highlighted`：拖拽文件卡悬停到本区域上方时为 true —— 高亮边框提示落点。
 */
import type { CSSProperties, PointerEventHandler } from 'react';
import type { Participant, RegionElement } from '@board/core';
import { cardRotation } from './util';
import { OwnerBadge } from './OwnerBadge';

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
  /** 当前操作者 id —— 用于「我的 / xxx 的」判定。 */
  actorId: string;
  /** 所有参与者，按 id 查找归属人名字与色板。 */
  participants: ReadonlyArray<Participant>;
  /** 点击徽标转让归属时回调；不传则徽标只读。 */
  onChangeOwner?: (nextOwnerId: string | null) => void;
}

/** 把 #rrggbb 与不透明度合成 rgba()；非法颜色回退陶土橙。 */
function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return `rgba(217, 119, 87, ${alpha})`;
  const v = parseInt(m[1]!, 16);
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${alpha})`;
}

export function RegionCard({
  element,
  highlighted = false,
  active = false,
  headerHandlers,
  actorId,
  participants,
  onChangeOwner,
}: RegionCardProps): JSX.Element {
  const { label, description, ownerId } = element;
  // 区域旋转幅度比卡片更小（大块容器，过度倾斜会显乱）—— 取一半。
  const rotation = cardRotation(element.id) * 0.5;

  const owner = ownerId ? participants.find((p) => p.id === ownerId) ?? null : null;
  const isMine = ownerId === actorId;

  // 用 owner.color 覆盖 .ov-region 的 --ov-stroke / --ov-fill。无归属时
  // 不设值 —— CSS 默认值（陶土橙）继续生效。
  const cssVars: CSSProperties = owner
    ? {
        transform: `rotate(${rotation}deg)`,
        ['--ov-stroke' as string]: owner.color,
        ['--ov-fill' as string]: hexToRgba(owner.color, 0.14),
      }
    : { transform: `rotate(${rotation}deg)` };

  const className =
    'ov-card ov-region' +
    (highlighted ? ' ov-region--drop' : '') +
    (active ? ' ov-region--active' : '') +
    (isMine ? ' ov-region--mine' : owner ? ' ov-region--others' : ' ov-region--public');

  return (
    <div className={className} style={cssVars} title={element.path}>
      {/* 头部 —— 兼作拖拽手柄 */}
      <div className="ov-region__head" {...headerHandlers}>
        <div className="ov-region__head-row">
          <span className="ov-region__label">{label || '未命名区域'}</span>
          <OwnerBadge
            owner={owner}
            isMine={isMine}
            actorId={actorId}
            participants={participants}
            onChangeOwner={onChangeOwner}
          />
        </div>
        {description ? (
          <span className="ov-region__desc">{description}</span>
        ) : null}
      </div>
      {/* 区域主体留白 —— 子文件靠 z 顺序叠在其上，此处不渲染子项。 */}
      <div className="ov-region__body" aria-hidden="true" />
    </div>
  );
}
