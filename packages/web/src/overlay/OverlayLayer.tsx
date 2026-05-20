/**
 * DOM 覆盖层 —— 叠在 Excalidraw 画布之上，与画布**共享坐标系**渲染内容元素。
 *
 * 坐标系对齐原理（PRD §11「内容元素层」）：
 *  Excalidraw 把画布坐标 (x,y) 映射到屏幕的公式是
 *      screen = (x + scrollX) * zoom
 *  覆盖层用一个变换容器复刻这条公式：
 *      transform: translate(scrollX*zoom, scrollY*zoom) scale(zoom)
 *      transform-origin: 0 0
 *
 * 渲染范围（M2）：只渲染 `file` / `folder` / `region` 三类内容元素。
 *
 * 交互：
 *  - 文件卡可拖拽（M2 增量2）：按卡片与区域的重叠面积判定落点 —— 落入不同
 *    区域则调 server move 改文件归属，落在原区域 / 收件区内则就地重新定位。
 *  - 区域可拖拽（拖头部）与八向缩放（四角四边手柄）。缩放下限钳制为
 *    「内容包围盒」—— 区域不会缩到压住其内文件。区域增删改经 PUT 落盘。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  BoardScene,
  Element,
  FileElement,
  RegionElement,
} from '@board/core';
import { regionsOf, regionForFile, arrangeScene } from '@board/core';
import { useBoard } from '../board/BoardContext';
import { moveFile } from '../server/files';
import { putScene } from '../server/client';
import { FileCard } from './FileCard';
import { FolderCard } from './FolderCard';
import {
  RegionCard,
  type PointerHandlers,
  type RegionResizeApi,
} from './RegionCard';
import { fileBaseName, intersectionArea, type RectLike } from './util';
import './overlay.css';

/** 覆盖层关心的视口状态 —— 取自 Excalidraw appState。 */
export interface OverlayViewport {
  /** 画布平移 X（appState.scrollX）。 */
  scrollX: number;
  /** 画布平移 Y（appState.scrollY）。 */
  scrollY: number;
  /** 缩放（appState.zoom.value）。 */
  zoom: number;
}

export interface OverlayLayerProps {
  /** 内存中的白板场景（board.json 真相源）。 */
  scene: BoardScene;
  /** 当前视口 —— 由 BoardCanvas 从 Excalidraw onChange 取得并下传。 */
  viewport: OverlayViewport;
}

/** 本覆盖层负责渲染的内容元素类型。 */
type ContentElement = Extract<Element, { type: 'file' | 'folder' | 'region' }>;

/** 判断一个元素是否属于本层渲染范围。 */
function isContentElement(el: Element): el is ContentElement {
  return el.type === 'file' || el.type === 'folder' || el.type === 'region';
}

/** 拖拽（移动）过程的瞬时状态 —— 文件卡或区域共用。 */
interface DragState {
  /** 被拖对象类型：文件卡 / 区域。 */
  kind: 'file' | 'region';
  /** 被拖元素 id。 */
  elementId: string;
  /** 捕获的指针 id。 */
  pointerId: number;
  /** 指针按下时的屏幕坐标。 */
  startScreenX: number;
  startScreenY: number;
  /** 元素拖拽前的画布坐标。 */
  startX: number;
  startY: number;
  /** 当前相对起点的画布坐标偏移。 */
  offsetX: number;
  offsetY: number;
  /** 是否已越过启动阈值（区分点击与拖拽）。 */
  moved: boolean;
}

/** 区域八向缩放过程的瞬时状态。 */
interface ResizeState {
  /** 被缩放的区域 id。 */
  elementId: string;
  /** 捕获的指针 id。 */
  pointerId: number;
  /** 手柄方向分量：-1=左/上边, 0=不动, 1=右/下边。 */
  hx: -1 | 0 | 1;
  hy: -1 | 0 | 1;
  /** 指针按下时的屏幕坐标。 */
  startScreenX: number;
  startScreenY: number;
  /** 缩放前矩形。 */
  x0: number;
  y0: number;
  w0: number;
  h0: number;
  /** 当前矩形（随指针实时更新，已 clamp）。 */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 缩放边界约束（由子元素包围盒推出；无子元素时为 ±Infinity 使约束失效）。 */
  maxRight: number;
  minLeft: number;
  maxBottom: number;
  minTop: number;
}

/** 启动拖拽的位移阈值（屏幕像素）—— 小于此值视为点击，不触发移动。 */
const DRAG_THRESHOLD_PX = 4;
/** 区域可缩放到的绝对最小尺寸（画布单位）。 */
const REGION_MIN_W = 240;
const REGION_MIN_H = 140;
/** 区域边缘到内容的留白下限；头部高度 —— 缩放时区域不能压到内容上。 */
const REGION_CONTENT_MARGIN = 16;
const REGION_HEADER_H = 48;

/**
 * 找出与拖拽中的文件卡重叠面积最大的区域；与任何区域都不重叠则返回 null
 * （落入收件区）。
 *
 * 按重叠面积判定而非卡片中心点 —— 中心点可能恰好落在两个相邻区域之间的
 * 间隙里，使卡片明明压在区域上却被误判为收件区、文件被弹到空白画布。
 */
function regionForCard(
  card: RectLike,
  regions: RegionElement[],
): RegionElement | null {
  let best: RegionElement | null = null;
  let bestArea = 0;
  for (const r of regions) {
    const area = intersectionArea(card, r);
    if (area <= 0) continue;
    // 面积更大者胜；面积相等时取 z 更高（最上层）的区域。
    if (area > bestArea || (area === bestArea && best !== null && r.z > best.z)) {
      best = r;
      bestArea = area;
    }
  }
  return best;
}

/** 按手柄方向与指针位移算出区域缩放后的矩形（含边界 clamp）。 */
function computeResize(
  r: ResizeState,
  dx: number,
  dy: number,
): { x: number; y: number; w: number; h: number } {
  const left0 = r.x0;
  const right0 = r.x0 + r.w0;
  const top0 = r.y0;
  const bottom0 = r.y0 + r.h0;

  let x = r.x0;
  let w = r.w0;
  if (r.hx === 1) {
    // 拖右边：右边界右移，不得越过内容右界、不得小于最小宽度。
    const right = Math.max(right0 + dx, r.maxRight, left0 + REGION_MIN_W);
    x = left0;
    w = right - left0;
  } else if (r.hx === -1) {
    // 拖左边：左边界右移上限为内容左界 / 最小宽度。
    const left = Math.min(left0 + dx, r.minLeft, right0 - REGION_MIN_W);
    x = left;
    w = right0 - left;
  }

  let y = r.y0;
  let h = r.h0;
  if (r.hy === 1) {
    const bottom = Math.max(bottom0 + dy, r.maxBottom, top0 + REGION_MIN_H);
    y = top0;
    h = bottom - top0;
  } else if (r.hy === -1) {
    const top = Math.min(top0 + dy, r.minTop, bottom0 - REGION_MIN_H);
    y = top;
    h = bottom0 - top;
  }
  return { x, y, w, h };
}

export function OverlayLayer({
  scene,
  viewport,
}: OverlayLayerProps): JSX.Element {
  const { scrollX, scrollY, zoom } = viewport;
  const { actorId, connection, replaceScene } = useBoard();

  // 拖拽 / 缩放瞬时状态；null = 未在进行。
  const [drag, setDrag] = useState<DragState | null>(null);
  const [resize, setResize] = useState<ResizeState | null>(null);
  // 右键上下文菜单位置（屏幕坐标）；null = 未显示。
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  // 持有最新场景，供拖拽结束（可能在异步之后）的落点计算读取，避免闭包陈旧。
  const sceneRef = useRef(scene);
  sceneRef.current = scene;

  // 筛出内容元素并按 z 升序排序 —— 字典序即层级序（与 factory.nextZ 同构）。
  const contentElements = useMemo<ContentElement[]>(() => {
    return scene.elements
      .filter(isContentElement)
      .sort((a, b) => (a.z < b.z ? -1 : a.z > b.z ? 1 : 0));
  }, [scene.elements]);

  // 拖拽文件卡时实时算出落点所在区域（仅文件拖拽需要）—— 用于高亮提示。
  const dropRegionId = useMemo<string | null>(() => {
    if (!drag || !drag.moved || drag.kind !== 'file') return null;
    const el = scene.elements.find((x) => x.id === drag.elementId);
    if (!el) return null;
    const cardRect: RectLike = {
      x: drag.startX + drag.offsetX,
      y: drag.startY + drag.offsetY,
      width: el.width,
      height: el.height,
    };
    const target = regionForCard(cardRect, regionsOf(scene.elements));
    return target ? target.id : null;
  }, [drag, scene.elements]);

  // 上下文菜单打开时，Esc 关闭。
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu]);

  /** 把场景中某元素的若干 envelope 字段打补丁，返回新场景。 */
  function patchElement(
    s: BoardScene,
    id: string,
    patch: Partial<
      Pick<Element, 'x' | 'y' | 'width' | 'height' | 'autoPlaced' | 'parentId'>
    >,
  ): BoardScene {
    const ts = new Date().toISOString();
    return {
      ...s,
      elements: s.elements.map((e) =>
        e.id === id
          ? ({ ...e, ...patch, updatedBy: actorId, updatedAt: ts } as Element)
          : e,
      ),
    };
  }

  /** 把场景中一组元素整体平移 (dx,dy)，返回新场景。 */
  function moveElementsBy(
    s: BoardScene,
    ids: Set<string>,
    dx: number,
    dy: number,
  ): BoardScene {
    const ts = new Date().toISOString();
    return {
      ...s,
      elements: s.elements.map((e) =>
        ids.has(e.id)
          ? ({
              ...e,
              x: e.x + dx,
              y: e.y + dy,
              updatedBy: actorId,
              updatedAt: ts,
            } as Element)
          : e,
      ),
    };
  }

  /** 把场景落盘到 server（已连接时）—— 区域移动 / 缩放等画布操作的持久化。 */
  function persist(next: BoardScene, what: string): void {
    if (connection !== 'connected') return;
    void putScene(next).catch((err: unknown) => {
      console.warn(`[board-web] 保存${what}失败（可稍后手动保存）：`, err);
    });
  }

  /** 同区域 / 收件区内拖拽文件卡 —— 仅就地重新定位（手动放置），不动文件归属。 */
  function repositionElement(
    base: BoardScene,
    el: FileElement,
    x: number,
    y: number,
  ): void {
    const next = patchElement(base, el.id, { x, y, autoPlaced: false });
    replaceScene(next, 'canvas');
    // 重新定位不涉及文件移动，不会触发 server reconcile，故需主动落盘。
    persist(next, '重新定位');
  }

  /** 跨区域拖拽文件卡 —— 经 server 移动真实文件以改变文件归属。 */
  async function doMove(
    base: BoardScene,
    el: FileElement,
    finalX: number,
    finalY: number,
    target: RegionElement | null,
    to: string,
  ): Promise<void> {
    // 乐观更新：先把卡片留在落点，避免移动往返期间卡片回弹再跳。
    const optimistic = patchElement(base, el.id, {
      x: finalX,
      y: finalY,
      autoPlaced: false,
      parentId: target ? target.id : null,
    });
    replaceScene(optimistic, 'canvas');
    try {
      // 传落点 —— server 据此把文件卡定位到松手处并保留位置（不自动排布）。
      await moveFile(el.path, to, finalX, finalY);
      // 成功：server 已同步并广播 board-changed，App 会经 SSE 刷回权威场景。
    } catch (err) {
      // 失败：回滚到拖拽前场景并提示原因（如目标区域已有同名文件）。
      replaceScene(base, 'canvas');
      const msg = err instanceof Error ? err.message : String(err);
      window.alert(`移动文件失败：${msg}`);
    }
  }

  /** 文件卡拖拽结束 —— 区域命中测试后决定「重新定位」或「跨区域移动」。 */
  function finishFileDrag(d: DragState): void {
    const curScene = sceneRef.current;
    const el = curScene.elements.find(
      (x): x is FileElement => x.id === d.elementId && x.type === 'file',
    );
    if (!el) return;

    const finalX = d.startX + d.offsetX;
    const finalY = d.startY + d.offsetY;
    const cardRect: RectLike = {
      x: finalX,
      y: finalY,
      width: el.width,
      height: el.height,
    };

    const regions = regionsOf(curScene.elements);
    const target = regionForCard(cardRect, regions);
    const current = regionForFile(el.path, regions);
    const sameRegion = (target?.id ?? null) === (current?.id ?? null);

    if (sameRegion) {
      repositionElement(curScene, el, finalX, finalY);
      return;
    }

    // 跨区域 —— 改变文件归属，须经 server 移动真实文件。
    if (connection !== 'connected') {
      window.alert('未连接 board-server，无法改变文件归属。');
      return;
    }
    const baseName = fileBaseName(el.path);
    const to = target ? `${target.path}/${baseName}` : baseName;
    void doMove(curScene, el, finalX, finalY, target, to);
  }

  /** 区域拖拽结束 —— 把区域及其内全部子元素整体平移，落盘。 */
  function finishRegionDrag(d: DragState): void {
    const curScene = sceneRef.current;
    const region = curScene.elements.find(
      (x): x is RegionElement => x.id === d.elementId && x.type === 'region',
    );
    if (!region) return;
    // 区域 + 其内子元素一起移动，保持「区域包含其内容」。
    const ids = new Set<string>([region.id]);
    for (const e of curScene.elements) {
      if (e.parentId === region.id) ids.add(e.id);
    }
    const next = moveElementsBy(curScene, ids, d.offsetX, d.offsetY);
    replaceScene(next, 'canvas');
    persist(next, '区域移动');
  }

  /** 拖拽结束分发。 */
  function finishDrag(d: DragState): void {
    if (d.kind === 'region') finishRegionDrag(d);
    else finishFileDrag(d);
  }

  /** 指针按下文件卡 / 区域头部 —— 捕获指针，记录起点，进入待拖拽状态。 */
  function beginDrag(
    e: React.PointerEvent<HTMLDivElement>,
    el: Element,
    kind: 'file' | 'region',
  ): void {
    if (e.button !== 0) return; // 仅响应主键
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({
      kind,
      elementId: el.id,
      pointerId: e.pointerId,
      startScreenX: e.clientX,
      startScreenY: e.clientY,
      startX: el.x,
      startY: el.y,
      offsetX: 0,
      offsetY: 0,
      moved: false,
    });
  }

  /** 指针移动 —— 把屏幕位移换算为画布偏移（除以 zoom），更新拖拽状态。 */
  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>): void {
    setDrag((d) => {
      if (!d || d.pointerId !== e.pointerId) return d;
      const dxScreen = e.clientX - d.startScreenX;
      const dyScreen = e.clientY - d.startScreenY;
      const moved =
        d.moved || Math.hypot(dxScreen, dyScreen) > DRAG_THRESHOLD_PX;
      return {
        ...d,
        offsetX: dxScreen / zoom,
        offsetY: dyScreen / zoom,
        moved,
      };
    });
  }

  /** 指针抬起 —— 释放捕获；越过阈值则落点处理，否则视为点击不处理。 */
  function handlePointerUp(e: React.PointerEvent<HTMLDivElement>): void {
    const d = drag;
    if (!d || d.pointerId !== e.pointerId) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // 指针捕获可能已自动释放，忽略。
    }
    setDrag(null);
    if (d.moved) finishDrag(d);
  }

  /** 指针取消（如系统手势打断）—— 直接丢弃拖拽，不改场景。 */
  function handlePointerCancel(e: React.PointerEvent<HTMLDivElement>): void {
    setDrag((d) => (d && d.pointerId === e.pointerId ? null : d));
  }

  /** 指针按下区域缩放手柄 —— 记录起始矩形与由内容包围盒推出的缩放边界。 */
  function beginResize(
    e: React.PointerEvent<HTMLDivElement>,
    region: RegionElement,
    hx: -1 | 0 | 1,
    hy: -1 | 0 | 1,
  ): void {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    // 子元素内容包围盒 → 缩放边界（区域不能缩到压住内容）。
    const kids = sceneRef.current.elements.filter(
      (x) => x.parentId === region.id,
    );
    let cl = Infinity;
    let cr = -Infinity;
    let ct = Infinity;
    let cb = -Infinity;
    for (const k of kids) {
      cl = Math.min(cl, k.x);
      cr = Math.max(cr, k.x + k.width);
      ct = Math.min(ct, k.y);
      cb = Math.max(cb, k.y + k.height);
    }
    setResize({
      elementId: region.id,
      pointerId: e.pointerId,
      hx,
      hy,
      startScreenX: e.clientX,
      startScreenY: e.clientY,
      x0: region.x,
      y0: region.y,
      w0: region.width,
      h0: region.height,
      x: region.x,
      y: region.y,
      w: region.width,
      h: region.height,
      // 无子元素时 cl/cr/ct/cb 为 ±Infinity，对应的 clamp 自然失效。
      maxRight: cr + REGION_CONTENT_MARGIN,
      minLeft: cl - REGION_CONTENT_MARGIN,
      maxBottom: cb + REGION_CONTENT_MARGIN,
      minTop: ct - REGION_CONTENT_MARGIN - REGION_HEADER_H,
    });
  }

  /** 缩放手柄移动 —— 按指针位移更新区域矩形（clamp 到内容边界）。 */
  function handleResizeMove(e: React.PointerEvent<HTMLDivElement>): void {
    setResize((r) => {
      if (!r || r.pointerId !== e.pointerId) return r;
      const dx = (e.clientX - r.startScreenX) / zoom;
      const dy = (e.clientY - r.startScreenY) / zoom;
      return { ...r, ...computeResize(r, dx, dy) };
    });
  }

  /** 缩放结束 —— 矩形有变化则提交并落盘。 */
  function handleResizeUp(e: React.PointerEvent<HTMLDivElement>): void {
    const r = resize;
    if (!r || r.pointerId !== e.pointerId) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // 已释放，忽略。
    }
    setResize(null);
    if (r.x !== r.x0 || r.y !== r.y0 || r.w !== r.w0 || r.h !== r.h0) {
      const next = patchElement(sceneRef.current, r.elementId, {
        x: r.x,
        y: r.y,
        width: r.w,
        height: r.h,
        autoPlaced: false,
      });
      replaceScene(next, 'canvas');
      persist(next, '区域缩放');
    }
  }

  /** 缩放取消 —— 丢弃，不改场景。 */
  function handleResizeCancel(e: React.PointerEvent<HTMLDivElement>): void {
    setResize((r) => (r && r.pointerId === e.pointerId ? null : r));
  }

  /** 右键内容元素 —— 打开 Board 上下文菜单（阻止浏览器默认菜单）。 */
  function handleContextMenu(e: React.MouseEvent<HTMLDivElement>): void {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY });
  }

  /** 关闭上下文菜单。 */
  function closeMenu(): void {
    setMenu(null);
  }

  /** 菜单项「自动对齐」—— 把所有文件在其区域 / 收件区内重新网格排布。 */
  function handleAutoArrange(): void {
    const next = arrangeScene(sceneRef.current);
    replaceScene(next, 'canvas');
    persist(next, '自动对齐');
    closeMenu();
  }

  // 变换容器样式 —— 复刻 Excalidraw 的 screen = (canvas + scroll) * zoom。
  const transformStyle: React.CSSProperties = {
    transform: `translate(${scrollX * zoom}px, ${scrollY * zoom}px) scale(${zoom})`,
    transformOrigin: '0 0',
  };

  return (
    <div className="ov-root" aria-hidden={contentElements.length === 0}>
      <div
        className="ov-transform"
        style={transformStyle}
        onContextMenu={handleContextMenu}
      >
        {contentElements.map((el) => {
          const isFile = el.type === 'file';

          // 拖拽偏移：被拖元素自身，或被拖区域的子元素（随区域一起动）。
          let dx = 0;
          let dy = 0;
          if (drag?.moved) {
            if (
              drag.elementId === el.id ||
              (drag.kind === 'region' && el.parentId === drag.elementId)
            ) {
              dx = drag.offsetX;
              dy = drag.offsetY;
            }
          }
          const offset = dx !== 0 || dy !== 0;

          // 缩放：被缩放区域自身实时变矩形（位置 + 尺寸都可能变）。
          const resizing = resize?.elementId === el.id;
          const rx = resizing && resize ? resize.x : el.x;
          const ry = resizing && resize ? resize.y : el.y;
          const rw = resizing && resize ? resize.w : el.width;
          const rh = resizing && resize ? resize.h : el.height;

          const regionActive =
            el.type === 'region' &&
            ((drag?.kind === 'region' && drag.elementId === el.id) || resizing);

          const slotStyle: React.CSSProperties = {
            left: `${rx}px`,
            top: `${ry}px`,
            width: `${rw}px`,
            height: `${rh}px`,
          };
          if (offset) {
            slotStyle.transform = `translate(${dx}px, ${dy}px)`;
          }

          const className =
            'ov-slot' +
            (isFile ? ' ov-slot--file' : '') +
            (offset ? ' ov-slot--dragging' : '');

          // 区域的拖拽手柄 / 八向缩放 API
          let headerHandlers: PointerHandlers | undefined;
          let resizeApi: RegionResizeApi | undefined;
          if (el.type === 'region') {
            const region = el;
            headerHandlers = {
              onPointerDown: (e) => beginDrag(e, region, 'region'),
              onPointerMove: handlePointerMove,
              onPointerUp: handlePointerUp,
              onPointerCancel: handlePointerCancel,
            };
            resizeApi = {
              onStart: (e, hx, hy) => beginResize(e, region, hx, hy),
              onMove: handleResizeMove,
              onUp: handleResizeUp,
              onCancel: handleResizeCancel,
            };
          }

          return (
            <div
              key={el.id}
              className={className}
              style={slotStyle}
              onPointerDown={
                isFile ? (e) => beginDrag(e, el, 'file') : undefined
              }
              onPointerMove={isFile ? handlePointerMove : undefined}
              onPointerUp={isFile ? handlePointerUp : undefined}
              onPointerCancel={isFile ? handlePointerCancel : undefined}
            >
              {el.type === 'region' ? (
                <RegionCard
                  element={el}
                  highlighted={el.id === dropRegionId}
                  active={regionActive}
                  headerHandlers={headerHandlers}
                  resize={resizeApi}
                />
              ) : el.type === 'folder' ? (
                <FolderCard element={el} />
              ) : (
                <FileCard element={el} />
              )}
            </div>
          );
        })}
      </div>

      {/* 右键上下文菜单 —— 唯一项「自动对齐」（平时拖拽不自动对齐，类访达） */}
      {menu ? (
        <>
          <div
            className="ov-menu-backdrop"
            onPointerDown={closeMenu}
            onContextMenu={(e) => {
              e.preventDefault();
              closeMenu();
            }}
          />
          <div
            className="ov-menu"
            style={{
              left: `${Math.min(menu.x, window.innerWidth - 196)}px`,
              top: `${Math.min(menu.y, window.innerHeight - 56)}px`,
            }}
          >
            <button
              type="button"
              className="ov-menu__item"
              onClick={handleAutoArrange}
            >
              <span className="ov-menu__icon" aria-hidden="true">
                ▦
              </span>
              自动对齐文件
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
