/**
 * DOM 覆盖层 —— 叠在 Excalidraw 画布之上，与画布**共享坐标系**渲染内容元素。
 *
 * 坐标系对齐原理（PRD §11「内容元素层」）：
 *  Excalidraw 把画布坐标 (x,y) 映射到屏幕的公式是
 *      screen = (x + scrollX) * zoom
 *  覆盖层用一个变换容器复刻这条公式：
 *      transform: translate(scrollX*zoom, scrollY*zoom) scale(zoom)
 *      transform-origin: 0 0
 *  容器内每个元素按其画布坐标 (x,y,width,height) 绝对定位，
 *  叠加容器变换后即与 Excalidraw 的视口完全一致——平移/缩放实时跟随。
 *
 * 渲染范围（M2）：只渲染 `file` / `folder` / `region` 三类内容元素；
 * draw/shape/connector/text 仍归 Excalidraw。元素按 `z` 升序扁平绝对定位。
 *
 * 交互：
 *  - 文件卡可拖拽（M2 增量2）：按卡片与区域的重叠面积判定落点 —— 落入不同
 *    区域则调 server move 改文件归属，落在原区域 / 收件区内则就地重新定位。
 *  - 区域可拖拽与缩放（M2 增量3）：拖头部移动整个区域（含其内文件），拖右下角
 *    手柄改大小（不小于内容包围盒）。区域增删改属画布操作，经 PUT /api/board 落盘。
 */
import { useMemo, useRef, useState } from 'react';
import type {
  BoardScene,
  Element,
  FileElement,
  RegionElement,
} from '@board/core';
import { regionsOf, regionForFile, regionContentSize } from '@board/core';
import { useBoard } from '../board/BoardContext';
import { moveFile } from '../server/files';
import { putScene } from '../server/client';
import { FileCard } from './FileCard';
import { FolderCard } from './FolderCard';
import { RegionCard, type PointerHandlers } from './RegionCard';
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

/** 区域缩放过程的瞬时状态。 */
interface ResizeState {
  /** 被缩放的区域 id。 */
  elementId: string;
  /** 捕获的指针 id。 */
  pointerId: number;
  /** 指针按下时的屏幕坐标。 */
  startScreenX: number;
  startScreenY: number;
  /** 缩放前尺寸。 */
  startW: number;
  startH: number;
  /** 当前尺寸（已 clamp 到下限）。 */
  w: number;
  h: number;
  /** 由区域内容包围盒决定的最小尺寸（不可缩到比内容更小）。 */
  minW: number;
  minH: number;
}

/** 启动拖拽的位移阈值（屏幕像素）—— 小于此值视为点击，不触发移动。 */
const DRAG_THRESHOLD_PX = 4;
/** 区域可缩放到的绝对最小尺寸（画布单位）。 */
const REGION_MIN_W = 240;
const REGION_MIN_H = 140;

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

export function OverlayLayer({
  scene,
  viewport,
}: OverlayLayerProps): JSX.Element {
  const { scrollX, scrollY, zoom } = viewport;
  const { actorId, connection, replaceScene } = useBoard();

  // 拖拽 / 缩放瞬时状态；null = 未在进行。
  const [drag, setDrag] = useState<DragState | null>(null);
  const [resize, setResize] = useState<ResizeState | null>(null);

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
      await moveFile(el.path, to);
      // 成功：server 已 reconcile 并广播 board-changed，App 会经 SSE 刷回权威场景。
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

  /** 指针按下区域缩放手柄 —— 记录起始尺寸与内容下限。 */
  function beginResize(
    e: React.PointerEvent<HTMLDivElement>,
    region: RegionElement,
  ): void {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const kids = sceneRef.current.elements.filter(
      (x) => x.parentId === region.id,
    );
    // 缩放下限 = max(绝对最小, 内容包围盒) —— 不能缩到比内容还小。
    const cs = regionContentSize(region, kids);
    setResize({
      elementId: region.id,
      pointerId: e.pointerId,
      startScreenX: e.clientX,
      startScreenY: e.clientY,
      startW: region.width,
      startH: region.height,
      w: region.width,
      h: region.height,
      minW: Math.max(REGION_MIN_W, cs.width),
      minH: Math.max(REGION_MIN_H, cs.height),
    });
  }

  /** 缩放手柄移动 —— 按指针位移更新区域尺寸（clamp 到内容下限）。 */
  function handleResizeMove(e: React.PointerEvent<HTMLDivElement>): void {
    setResize((r) => {
      if (!r || r.pointerId !== e.pointerId) return r;
      const w = Math.max(r.minW, r.startW + (e.clientX - r.startScreenX) / zoom);
      const h = Math.max(r.minH, r.startH + (e.clientY - r.startScreenY) / zoom);
      return { ...r, w, h };
    });
  }

  /** 缩放结束 —— 尺寸有变化则提交并落盘。 */
  function handleResizeUp(e: React.PointerEvent<HTMLDivElement>): void {
    const r = resize;
    if (!r || r.pointerId !== e.pointerId) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // 已释放，忽略。
    }
    setResize(null);
    if (r.w !== r.startW || r.h !== r.startH) {
      const next = patchElement(sceneRef.current, r.elementId, {
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

  // 变换容器样式 —— 复刻 Excalidraw 的 screen = (canvas + scroll) * zoom。
  const transformStyle: React.CSSProperties = {
    transform: `translate(${scrollX * zoom}px, ${scrollY * zoom}px) scale(${zoom})`,
    transformOrigin: '0 0',
  };

  return (
    <div className="ov-root" aria-hidden={contentElements.length === 0}>
      <div className="ov-transform" style={transformStyle}>
        {contentElements.map((el) => {
          const isFile = el.type === 'file';
          const isRegion = el.type === 'region';

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

          // 缩放：被缩放区域自身实时变尺寸。
          const resizing = resize?.elementId === el.id;
          const w = resizing && resize ? resize.w : el.width;
          const h = resizing && resize ? resize.h : el.height;

          const regionActive =
            isRegion &&
            ((drag?.kind === 'region' && drag.elementId === el.id) || resizing);

          const slotStyle: React.CSSProperties = {
            left: `${el.x}px`,
            top: `${el.y}px`,
            width: `${w}px`,
            height: `${h}px`,
          };
          if (offset) {
            slotStyle.transform = `translate(${dx}px, ${dy}px)`;
          }

          const className =
            'ov-slot' +
            (isFile ? ' ov-slot--file' : '') +
            (offset ? ' ov-slot--dragging' : '');

          // 区域的拖拽 / 缩放手柄事件
          let headerHandlers: PointerHandlers | undefined;
          let resizeHandlers: PointerHandlers | undefined;
          if (el.type === 'region') {
            const region = el;
            headerHandlers = {
              onPointerDown: (e) => beginDrag(e, region, 'region'),
              onPointerMove: handlePointerMove,
              onPointerUp: handlePointerUp,
              onPointerCancel: handlePointerCancel,
            };
            resizeHandlers = {
              onPointerDown: (e) => beginResize(e, region),
              onPointerMove: handleResizeMove,
              onPointerUp: handleResizeUp,
              onPointerCancel: handleResizeCancel,
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
                  resizeHandlers={resizeHandlers}
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
    </div>
  );
}
