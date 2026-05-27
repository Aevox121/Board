/**
 * 单个画布元素的卡槽（slot）—— 从 OverlayLayer 的 visibleElements.map 抽出来
 * 单独 memo 的组件。性能命门：父层任何状态变更（viewport / hover / 拖拽中
 * 其它元素 / 选区变化 / 编辑态切换 ...）都会触发 OverlayLayer 重渲，但只要
 * 本元素相关的 props 没变，本组件就跳过整段计算 —— 这是 10 元素就开始卡的
 * 主要修复点。
 *
 * 设计：
 *  - 把瞬时变换（drag/resize/rotate/groupGeom）已经折算成本元素的 dx/dy/
 *    liveX/liveY/liveW/liveH/liveAngle/liveDrawPoints 等基本类型 prop；
 *    不传 transient state 对象本身（对象引用每次都新）。
 *  - 所有事件回调走 `actions: SlotActions` 单一稳定束（OverlayLayer 用 ref+
 *    useMemo 模式把 actions 对象做成跨渲染恒定引用，方法内部通过 ref 读
 *    最新闭包），避免 ~30 个回调 prop 各自携带新引用击穿 memo。
 *  - 选区相关读写也走 actions（actions.selectedIdsHas / selectedIdsSize），
 *    本组件本身只接收一个 `selected: boolean` 用于渲染选择框。
 */
import type {
  PointerEventHandler,
  MouseEventHandler,
  CSSProperties,
} from 'react';
import { memo, useEffect, useRef } from 'react';
import { dragStore } from './dragStore';
import { renderCounters } from '../canvas/renderCounters';
import type {
  DrawElement,
  Element,
  FileElement,
  FolderElement,
  Participant,
  ParticipantId,
  RegionElement,
  TextElement,
} from '@board/core';
import { DEFAULT_STYLE } from '@board/core';

import { FileCard, isFileEditable } from './FileCard';
import { FolderCard } from './FolderCard';
import { TextCard } from './TextCard';
import { ImageView } from './ImageView';
import { EmbedView } from './EmbedView';
import { RegionCard, type PointerHandlers } from './RegionCard';
import { ResizeHandles, type ResizeApi } from './ResizeHandles';
import { ShapeView } from '../canvas/ShapeView';
import { DrawView } from '../canvas/DrawView';
import {
  COLLAPSED_REGION_HEIGHT,
  SelectionFrame,
  styleVars,
  type CanvasElement,
  type DragKind,
} from './OverlayLayer';

/** 缩放进行中的手绘元素 —— 采样点按比例实时缩放。 */
function liveDrawElement(
  el: DrawElement,
  w0: number,
  h0: number,
  w: number,
  h: number,
): DrawElement {
  const sx = w0 > 0 ? w / w0 : 1;
  const sy = h0 > 0 ? h / h0 : 1;
  return {
    ...el,
    width: w,
    height: h,
    points: el.points.map((p): [number, number] => [p[0] * sx, p[1] * sy]),
  };
}

/**
 * 父层注入到卡槽的稳定动作束。本对象在父层 `useMemo([], ...)` 一次性创建，
 * 方法通过 ref 读最新闭包，故跨渲染引用恒定 —— 不会击穿 memo。
 */
export interface SlotActions {
  // ─── 选区 ─────────────────────────────────────────────
  toggleInSelection(id: string): void;
  groupMembersOf(id: string): Set<string>;
  setSelectedIds(ids: ReadonlySet<string>): void;
  selectedIdsHas(id: string): boolean;
  selectedIdsSize(): number;

  // ─── 拖拽（slot / region 头部）─────────────────────────
  beginDrag(
    e: React.PointerEvent<HTMLDivElement>,
    el: Element,
    kind: DragKind,
    explicitMembers?: ReadonlySet<string>,
  ): void;
  handlePointerMove: PointerEventHandler<HTMLDivElement>;
  handlePointerUp: PointerEventHandler<HTMLDivElement>;
  handlePointerCancel: PointerEventHandler<HTMLDivElement>;

  // ─── 缩放 / 旋转 ────────────────────────────────────────
  beginResize(
    e: React.PointerEvent<HTMLDivElement>,
    el: CanvasElement,
    hx: -1 | 0 | 1,
    hy: -1 | 0 | 1,
  ): void;
  handleResizeMove: PointerEventHandler<HTMLDivElement>;
  handleResizeUp: PointerEventHandler<HTMLDivElement>;
  handleResizeCancel: PointerEventHandler<HTMLDivElement>;
  beginRotate(
    e: React.PointerEvent<HTMLDivElement>,
    el: CanvasElement,
  ): void;
  handleRotateMove: PointerEventHandler<HTMLDivElement>;
  handleRotateUp: PointerEventHandler<HTMLDivElement>;
  handleRotateCancel: PointerEventHandler<HTMLDivElement>;

  // ─── 区域 ──────────────────────────────────────────────
  changeRegionOwner(id: string, nextOwnerId: string | null): void;
  setRegionCollapsed(id: string, value: boolean): void;
  setRegionAutoFile(id: string, value: boolean): void;
  setEditingRegionId(id: string | null): void;

  // ─── 文件夹 ────────────────────────────────────────────
  setFolderExpanded(id: string, value: boolean): void;
  setFolderViewMode(id: string, mode: FolderElement['viewMode']): void;

  // ─── 文本卡 ────────────────────────────────────────────
  commitTextMarkdown(id: string, markdown: string): void;
  resizeTextElement(id: string, height: number): void;
  setEditingTextId(id: string | null): void;

  // ─── 图形标签 ──────────────────────────────────────────
  commitShapeLabel(id: string, text: string): void;
  setEditingLabelId(id: string | null): void;

  // ─── 文件卡 ────────────────────────────────────────────
  resizeFileElement(id: string, height: number): void;
  setEditingFileId(id: string | null): void;
  getElements(): readonly Element[];
  navigateToElement(id: string): void;

  // ─── 评论 / 状态角标 ───────────────────────────────────
  openComment(elementId: string, anchor: { x: number; y: number }): void;
  ackFileStatus(id: string): void;
}

export interface ElementSlotProps {
  element: CanvasElement;
  /** 当前操作者 —— RegionCard 显示「我的 / xxx 的」。 */
  actorId: ParticipantId;
  /** 参与者列表 —— RegionCard 名牌色板查找。 */
  participants: ReadonlyArray<Participant>;

  // ── 瞬时变换（父层已折算到本元素，未在变换中传 0 / null）─────
  dx: number;
  dy: number;
  liveX: number | null;
  liveY: number | null;
  liveW: number | null;
  liveH: number | null;
  liveAngle: number | null;
  /** 仅 draw 元素在 group 变换中需要 —— 父层从 groupGeom 取出。 */
  liveDrawPoints: ReadonlyArray<readonly [number, number]> | null;

  // ── 元素级布尔标志 ─────────────────────────────────────
  collapsed: boolean;
  selected: boolean;
  /** 单选高亮（出八向手柄）。 */
  solo: boolean;
  /** region: 是否为当前拖拽落点。 */
  dropTarget: boolean;
  /** region: 是否正被拖拽 / 缩放。 */
  regionActive: boolean;
  editingLabel: boolean;
  editingText: boolean;
  editingFile: boolean;
  missing: boolean;
  /**
   * file 元素的 Agent 活动状态（已 ack 也算 null）—— 父层算好后作为 primitive
   * 下传，避免把 ackedFileStatusIds 这个 set 引用整个传进来反复击穿 memo。
   */
  agentStatus: 'new' | 'modified' | null;
  /** shape ellipse / diamond / draw 的命中区裁剪。null = 矩形卡槽，无裁剪。 */
  clipPath: string | null;

  /** 稳定动作束 —— 父层 useMemo 一次创建。 */
  actions: SlotActions;
}

function ElementSlotImpl({
  element,
  actorId,
  participants,
  dx,
  dy,
  liveX,
  liveY,
  liveW,
  liveH,
  liveAngle,
  liveDrawPoints,
  collapsed,
  selected,
  solo,
  dropTarget,
  regionActive,
  editingLabel,
  editingText,
  editingFile,
  missing,
  agentStatus,
  clipPath,
  actions,
}: ElementSlotProps): JSX.Element {
  renderCounters.bump('ElementSlot');
  const el = element;
  const isFile = el.type === 'file';
  const isText = el.type === 'text';
  const isShape = el.type === 'shape';
  const isDraw = el.type === 'draw';
  const isImage = el.type === 'image';
  const isEmbed = el.type === 'embed';

  const rx = liveX ?? el.x;
  const ry = liveY ?? el.y;
  const rw = liveW ?? el.width;
  let rh = liveH ?? el.height;
  if (collapsed) rh = COLLAPSED_REGION_HEIGHT;

  const ang =
    el.type === 'region' ? 0 : (liveAngle ?? el.angle ?? 0);

  // baseTransform —— 只含 rotate（无 translate）。拖动期间 dragStore 会在
  // 这上面叠加 `translate(dx, dy)` 直接 mutate DOM style.transform，**不走
  // React**。dx/dy 不再参与本组件的 slotStyle 计算。
  const baseTransform = ang ? `rotate(${ang}rad)` : '';

  const slotStyle: CSSProperties = {
    left: `${rx}px`,
    top: `${ry}px`,
    width: `${rw}px`,
    height: `${rh}px`,
  };
  if (baseTransform) slotStyle.transform = baseTransform;
  Object.assign(slotStyle, styleVars(el.style));
  if (el.style.opacity !== DEFAULT_STYLE.opacity) {
    slotStyle.opacity = el.style.opacity / 100;
  }

  const className =
    'ov-slot' +
    (isFile ? ' ov-slot--file' : '') +
    (isText ? ' ov-slot--text' : '') +
    (isShape || isDraw ? ' ov-slot--shape' : '') +
    (isImage || isEmbed ? ' ov-slot--media' : '') +
    (el.state === 'draft' ? ' ov-slot--draft' : '');

  // ── 把本 slot 的根 DOM 注册到 dragStore ─────────────────────
  // 拖动期间 dragStore 直接 mutate slot 的 style.transform（叠加 baseTransform
  // 之上的 translate(dx, dy)），完全 bypass React。每次 baseTransform 变化
  // （rotate 变了等）都同步给 store。
  const slotRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => dragStore.registerSlot(el.id, slotRef.current, baseTransform), [el.id]);
  useEffect(() => {
    dragStore.updateBaseTransform(el.id, baseTransform);
  }, [el.id, baseTransform]);

  // 区域头部拖拽手柄（仅区域）—— 兼作区域的点选入口。
  let headerHandlers: PointerHandlers | undefined;
  if (el.type === 'region') {
    const region = el;
    headerHandlers = {
      onPointerDown: (e) => {
        if (e.button !== 0) return;
        if (e.shiftKey) {
          actions.toggleInSelection(region.id);
          return;
        }
        const gset = actions.groupMembersOf(region.id);
        const keepSel =
          actions.selectedIdsHas(region.id) && actions.selectedIdsSize() > 1;
        if (!keepSel) actions.setSelectedIds(gset);
        const groupDrag = keepSel || gset.size > 1;
        actions.beginDrag(
          e,
          region,
          groupDrag ? 'group' : 'region',
          !keepSel && groupDrag ? gset : undefined,
        );
      },
      onPointerMove: actions.handlePointerMove,
      onPointerUp: actions.handlePointerUp,
      onPointerCancel: actions.handlePointerCancel,
      onDoubleClick: region.locked
        ? undefined
        : () => actions.setEditingRegionId(region.id),
    };
  }

  // 八向缩放 API —— 文件 / 文本 / 文件夹 / 区域所有内容卡通用。
  const resizeApi: ResizeApi = {
    onStart: (e, hx, hy) => actions.beginResize(e, el, hx, hy),
    onMove: actions.handleResizeMove,
    onUp: actions.handleResizeUp,
    onCancel: actions.handleResizeCancel,
    onRotateStart: (e) => actions.beginRotate(e, el),
    onRotateMove: actions.handleRotateMove,
    onRotateUp: actions.handleRotateUp,
    onRotateCancel: actions.handleRotateCancel,
  };

  // 拖拽 kind：region 走头部、本路径不发起；其它都走通用矩形拖拽路径。
  const dragKind: DragKind | null =
    el.type === 'region'
      ? null
      : el.type === 'file'
        ? 'file'
        : el.type === 'text'
          ? 'text'
          : 'element';

  const slotPointerDown =
    dragKind === null
      ? undefined
      : (e: React.PointerEvent<HTMLDivElement>): void => {
          if (e.button !== 0) return;
          if (el.locked) {
            if (e.shiftKey) actions.toggleInSelection(el.id);
            else actions.setSelectedIds(new Set([el.id]));
            return;
          }
          if (e.shiftKey) {
            actions.toggleInSelection(el.id);
            return;
          }
          const gset = actions.groupMembersOf(el.id);
          const keepSel =
            actions.selectedIdsHas(el.id) && actions.selectedIdsSize() > 1;
          if (!keepSel) actions.setSelectedIds(gset);
          const groupDrag = keepSel || gset.size > 1;
          if (groupDrag) {
            actions.beginDrag(e, el, 'group', keepSel ? undefined : gset);
          } else {
            actions.beginDrag(e, el, dragKind);
          }
        };

  const slotDoubleClick: MouseEventHandler<HTMLDivElement> | undefined =
    el.locked
      ? undefined
      : isShape
        ? () => actions.setEditingLabelId(el.id)
        : isText
          ? () => actions.setEditingTextId(el.id)
          : isFile && isFileEditable(el, missing)
            ? () => actions.setEditingFileId(el.id)
            : undefined;

  // 缩放中的 ShapeView / DrawView 元素需要带入实时尺寸。
  const liveSizing = liveW !== null || liveH !== null;
  const shapeViewEl =
    liveSizing && el.type === 'shape'
      ? { ...el, width: rw, height: rh }
      : el;
  const drawViewEl =
    el.type === 'draw'
      ? liveDrawPoints
        ? { ...el, width: rw, height: rh, points: [...liveDrawPoints] as DrawElement['points'] }
        : liveSizing
          ? liveDrawElement(el, el.width, el.height, rw, rh)
          : el
      : el;

  return (
    <div
      ref={slotRef}
      className={clipPath ? `${className} ov-slot--clipped` : className}
      style={slotStyle}
      data-element-id={el.id}
      onPointerDown={clipPath ? undefined : slotPointerDown}
      onPointerMove={
        clipPath || el.type === 'region' ? undefined : actions.handlePointerMove
      }
      onPointerUp={
        clipPath || el.type === 'region' ? undefined : actions.handlePointerUp
      }
      onPointerCancel={
        clipPath || el.type === 'region'
          ? undefined
          : actions.handlePointerCancel
      }
      onDoubleClick={clipPath ? undefined : slotDoubleClick}
    >
      {el.type === 'region' ? (
        <RegionCard
          element={el as RegionElement}
          highlighted={dropTarget}
          active={regionActive}
          headerHandlers={headerHandlers}
          actorId={actorId}
          participants={participants}
          onChangeOwner={(next) => actions.changeRegionOwner(el.id, next)}
          onToggleCollapsed={
            el.locked
              ? undefined
              : () =>
                  actions.setRegionCollapsed(
                    el.id,
                    !(el as RegionElement).collapsed,
                  )
          }
          onToggleAutoFile={
            el.locked
              ? undefined
              : () =>
                  actions.setRegionAutoFile(
                    el.id,
                    !(el as RegionElement).autoFile,
                  )
          }
        />
      ) : el.type === 'folder' ? (
        <FolderCard
          element={el as FolderElement}
          onToggleExpanded={
            el.locked
              ? undefined
              : () =>
                  actions.setFolderExpanded(
                    el.id,
                    !(el as FolderElement).expanded,
                  )
          }
          onChangeViewMode={
            el.locked
              ? undefined
              : (mode) => actions.setFolderViewMode(el.id, mode)
          }
        />
      ) : el.type === 'text' ? (
        <TextCard
          element={el as TextElement}
          onCommit={(md) => actions.commitTextMarkdown(el.id, md)}
          onResize={(h) => actions.resizeTextElement(el.id, h)}
          editing={editingText}
          onEditingChange={(next) =>
            actions.setEditingTextId(next ? el.id : null)
          }
        />
      ) : el.type === 'shape' ? (
        <ShapeView
          element={shapeViewEl as typeof el}
          editingLabel={editingLabel}
          onLabelCommit={(t) => {
            actions.commitShapeLabel(el.id, t);
            actions.setEditingLabelId(null);
          }}
          onLabelCancel={() => actions.setEditingLabelId(null)}
        />
      ) : el.type === 'draw' ? (
        <DrawView element={drawViewEl as DrawElement} />
      ) : el.type === 'image' ? (
        <ImageView element={el} />
      ) : el.type === 'embed' ? (
        <EmbedView element={el} />
      ) : (
        <FileCard
          element={el as FileElement}
          missing={missing}
          onResize={(h) => actions.resizeFileElement(el.id, h)}
          getElements={actions.getElements}
          navigateToElement={actions.navigateToElement}
          editing={editingFile}
          onEditingChange={(next) =>
            actions.setEditingFileId(next ? el.id : null)
          }
        />
      )}
      {/* 形状命中层（椭圆 / 菱形 / draw）—— clip-path 裁形，承接 pointer。 */}
      {clipPath ? (
        <div
          className="ov-shape-hit"
          style={{
            clipPath,
            pointerEvents: editingLabel ? 'none' : undefined,
          }}
          onPointerDown={slotPointerDown}
          onPointerMove={actions.handlePointerMove}
          onPointerUp={actions.handlePointerUp}
          onPointerCancel={actions.handlePointerCancel}
          onDoubleClick={slotDoubleClick}
        />
      ) : null}
      {/* 选中框 */}
      {selected ? (
        <SelectionFrame element={el} width={rw} height={rh} />
      ) : null}
      {/* 八向缩放手柄（单选时） */}
      {solo && !el.locked && !collapsed ? (
        <ResizeHandles api={resizeApi} rotatable={el.type !== 'region'} />
      ) : null}
      {/* 锁定角标 */}
      {el.locked ? (
        <div className="ov-lock-badge" aria-hidden="true">
          🔒
        </div>
      ) : null}
      {/* 外链角标 */}
      {el.link ? (
        <a
          className="ov-link-badge"
          href={el.link}
          target="_blank"
          rel="noopener noreferrer"
          title={`打开外链：${el.link}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          aria-label="打开外链"
        >
          🔗
        </a>
      ) : null}
      {/* 评论角标 */}
      {(el.comments?.length ?? 0) > 0
        ? (() => {
            const all = el.comments ?? [];
            const unresolved = all.filter((c) => !c.resolved).length;
            return (
              <button
                type="button"
                className={
                  'ov-comment-badge' +
                  (unresolved === 0 ? ' ov-comment-badge--all-resolved' : '')
                }
                title={
                  unresolved > 0
                    ? `${unresolved} 条未解决 / 共 ${all.length} 条 —— 点击查看`
                    : `共 ${all.length} 条（已全部解决）—— 点击查看`
                }
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  actions.openComment(el.id, { x: r.right, y: r.bottom });
                }}
              >
                💬 {unresolved > 0 ? unresolved : all.length}
              </button>
            );
          })()
        : null}
      {/* 文件 Agent 活动角标 */}
      {el.type === 'file' && agentStatus
        ? (() => {
            const isNew = agentStatus === 'new';
            const ts = isNew
              ? (el as FileElement).createdAt
              : (el as FileElement).updatedAt;
            const who = isNew
              ? (el as FileElement).createdBy
              : (el as FileElement).updatedBy;
            const label = isNew ? '新增' : '改过';
            return (
              <button
                type="button"
                className={
                  'ov-file-status-badge ov-file-status-badge--' +
                  (isNew ? 'new' : 'modified')
                }
                title={`Agent ${label}（${who} · ${ts}）—— 点击标记已读`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  actions.ackFileStatus(el.id);
                }}
                aria-label={`Agent ${label}，点击标记已读`}
              >
                {isNew ? '✨' : '✎'}
              </button>
            );
          })()
        : null}
    </div>
  );
}

/**
 * 元素卡槽 —— 默认浅比较 memo。父层把每个元素相关的 prop 都拆成基本类型 /
 * 稳定引用，未变化的元素得以跳过整段重渲，从而把 viewport 平移 / 缩放
 * 这种"父层频繁重渲、本元素无变化"的场景压回 O(1)。
 */
export const ElementSlot = memo(ElementSlotImpl);
