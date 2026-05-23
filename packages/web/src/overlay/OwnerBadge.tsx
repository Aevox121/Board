/**
 * 区域归属徽标 —— PRD §8.3 软归属。
 *
 * 显示「我的区域 / xxx 的区域 / 公共区域」chip。带 onChangeOwner 时点击展开
 * 小菜单，可设为我的 / 公共 / 转让给其他参与者；不带 onChangeOwner 则只读。
 *
 * 「软」归属：仅作视觉提示，不强制锁定 —— 别人仍能编辑该区域内的元素。
 */
import { useEffect, useRef, useState } from 'react';
import type { Participant } from '@board/core';
import './OwnerBadge.css';

export interface OwnerBadgeProps {
  /** 当前归属参与者；null = 公共区域。 */
  owner: Participant | null;
  /** 归属人是否为当前 actor。 */
  isMine: boolean;
  /** 当前操作者 id —— 「设为我的」分支用。 */
  actorId: string;
  /** 所有参与者，用于「转让给…」候选列表。 */
  participants: ReadonlyArray<Participant>;
  /** 不传则只读；传了则可点击展开转让菜单。 */
  onChangeOwner?: (nextOwnerId: string | null) => void;
}

function badgeText(owner: Participant | null, isMine: boolean): string {
  if (!owner) return '公共区域';
  if (isMine) return '我的区域';
  return `${owner.name} 的区域`;
}

export function OwnerBadge({
  owner,
  isMine,
  actorId,
  participants,
  onChangeOwner,
}: OwnerBadgeProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 菜单打开后，点外部 / Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onDocPointer = (e: PointerEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDocPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDocPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const readonly = !onChangeOwner;
  const chipColor = owner?.color ?? 'var(--c-accent)';
  const chipClass =
    'ov-owner-badge' +
    (isMine ? ' ov-owner-badge--mine' : owner ? ' ov-owner-badge--others' : ' ov-owner-badge--public') +
    (readonly ? ' ov-owner-badge--readonly' : '');

  // 转让候选 —— 当前 actor + 其它参与者；去重 + 排除当前 owner
  const others = participants.filter((p) => p.id !== owner?.id);
  const selfNotOwner = !isMine; // 是否能「设为我的」
  const canMakePublic = owner !== null; // 是否能「设为公共」

  return (
    <div className="ov-owner-badge-root" ref={rootRef}>
      <button
        type="button"
        className={chipClass}
        title={readonly ? badgeText(owner, isMine) : '点击转让归属'}
        disabled={readonly}
        onPointerDown={(e) => {
          // 阻止冒泡到区域头部拖拽手柄，避免点击触发区域拖拽。
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.stopPropagation();
          if (!readonly) setOpen((v) => !v);
        }}
      >
        <span
          className="ov-owner-badge__dot"
          style={{ background: chipColor }}
          aria-hidden="true"
        />
        <span className="ov-owner-badge__text">{badgeText(owner, isMine)}</span>
      </button>
      {open && !readonly && (
        <div
          className="ov-owner-menu"
          role="menu"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {selfNotOwner && (
            <button
              type="button"
              className="ov-owner-menu__item"
              onClick={() => {
                setOpen(false);
                onChangeOwner?.(actorId);
              }}
            >
              <span className="ov-owner-menu__dot" style={{ background: 'var(--c-accent)' }} aria-hidden="true" />
              设为我的
            </button>
          )}
          {others
            .filter((p) => p.id !== actorId)
            .map((p) => (
              <button
                key={p.id}
                type="button"
                className="ov-owner-menu__item"
                onClick={() => {
                  setOpen(false);
                  onChangeOwner?.(p.id);
                }}
              >
                <span
                  className="ov-owner-menu__dot"
                  style={{ background: p.color }}
                  aria-hidden="true"
                />
                转让给 {p.name}
              </button>
            ))}
          {canMakePublic && (
            <button
              type="button"
              className="ov-owner-menu__item ov-owner-menu__item--mute"
              onClick={() => {
                setOpen(false);
                onChangeOwner?.(null);
              }}
            >
              <span className="ov-owner-menu__dot ov-owner-menu__dot--empty" aria-hidden="true" />
              设为公共
            </button>
          )}
        </div>
      )}
    </div>
  );
}
