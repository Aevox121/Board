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
 * 事件穿透：
 *  - 外层 `pointer-events:none` —— 空白处事件穿透到下面的 Excalidraw。
 *  - 卡片本身 `pointer-events:auto`（见 overlay.css）—— 可交互。
 *
 * 渲染范围（M2）：只渲染 `file` / `folder` / `region` 三类内容元素；
 * draw/shape/connector/text 仍归 Excalidraw，本层不碰。元素按 `z` 升序
 * 扁平绝对定位 —— 区域 z 低 → 在下，文件 z 高 → 叠在区域之上。
 *
 * 拖拽改归属（M2 增量2 — 画布 → 文件系统）：
 *  - 文件卡可拖动。拖拽以指针落点的卡片中心做区域命中测试。
 *  - 落入不同区域 → 调 server `POST /api/files/move` 移动真实文件，
 *    server reconcile 后经 SSE 把权威场景刷回。
 *  - 落在原区域 / 收件区内 → 仅就地重新定位（手动放置），不动文件归属。
 */
import { useMemo, useRef, useState } from 'react';
import type {
  BoardScene,
  Element,
  FileElement,
  RegionElement,
} from '@board/core';
import { regionsOf, regionForFile } from '@board/core';
import { useBoard } from '../board/BoardContext';
import { moveFile } from '../server/files';
import { putScene } from '../server/client';
import { FileCard } from './FileCard';
import { FolderCard } from './FolderCard';
import { RegionCard } from './RegionCard';
import { fileBaseName, pointInRect } from './util';
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

/** 文件卡拖拽过程的瞬时状态。 */
interface DragState {
  /** 被拖拽的 file 元素 id。 */
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

/** 启动拖拽的位移阈值（屏幕像素）—— 小于此值视为点击，不触发移动。 */
const DRAG_THRESHOLD_PX = 4;

/**
 * 找出覆盖某画布坐标点的区域；多个重叠时取 z 最高（最上层）的一个。
 * 区域卡的微旋转幅度极小，按轴对齐矩形近似命中测试。
 */
function regionAt(
  px: number,
  py: number,
  regions: RegionElement[],
): RegionElement | null {
  let best: RegionElement | null = null;
  for (const r of regions) {
    if (pointInRect(px, py, r) && (!best || r.z > best.z)) {
      best = r;
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

  // 拖拽瞬时状态；null = 未在拖拽。
  const [drag, setDrag] = useState<DragState | null>(null);

  // 持有最新场景，供拖拽结束（可能在异步之后）的落点计算读取，避免闭包陈旧。
  const sceneRef = useRef(scene);
  sceneRef.current = scene;

  // 筛出内容元素并按 z 升序排序 —— 字典序即层级序（与 factory.nextZ 同构）。
  // 区域 z 通常低于其内文件 → 文件自然叠在区域之上（靠 z，不做 DOM 嵌套）。
  const contentElements = useMemo<ContentElement[]>(() => {
    return scene.elements
      .filter(isContentElement)
      .sort((a, b) => (a.z < b.z ? -1 : a.z > b.z ? 1 : 0));
  }, [scene.elements]);

  // 拖拽中：实时算出落点所在区域 —— 用于高亮提示目标区域。
  const dropRegionId = useMemo<string | null>(() => {
    if (!drag || !drag.moved) return null;
    const el = scene.elements.find((x) => x.id === drag.elementId);
    if (!el) return null;
    const cx = drag.startX + drag.offsetX + el.width / 2;
    const cy = drag.startY + drag.offsetY + el.height / 2;
    const target = regionAt(cx, cy, regionsOf(scene.elements));
    return target ? target.id : null;
  }, [drag, scene.elements]);

  /** 把场景中某元素的若干 envelope 字段打补丁，返回新场景。 */
  function patchElement(
    s: BoardScene,
    id: string,
    patch: Partial<Pick<Element, 'x' | 'y' | 'autoPlaced' | 'parentId'>>,
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

  /** 同区域 / 收件区内拖拽 —— 仅就地重新定位（手动放置），不动文件归属。 */
  function repositionElement(
    base: BoardScene,
    el: FileElement,
    x: number,
    y: number,
  ): void {
    const next = patchElement(base, el.id, { x, y, autoPlaced: false });
    replaceScene(next, 'canvas');
    // 已连接则持久化 —— 重新定位不涉及文件移动，不会触发 server reconcile。
    if (connection === 'connected') {
      void putScene(next).catch((err: unknown) => {
        console.warn('[board-web] 保存重新定位失败（可稍后手动保存）：', err);
      });
    }
  }

  /** 跨区域拖拽 —— 经 server 移动真实文件以改变文件归属。 */
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

  /** 拖拽结束 —— 区域命中测试后决定「重新定位」或「跨区域移动」。 */
  function finishDrag(d: DragState): void {
    const curScene = sceneRef.current;
    const el = curScene.elements.find(
      (x): x is FileElement => x.id === d.elementId && x.type === 'file',
    );
    if (!el) return;

    const finalX = d.startX + d.offsetX;
    const finalY = d.startY + d.offsetY;
    const centerX = finalX + el.width / 2;
    const centerY = finalY + el.height / 2;

    const regions = regionsOf(curScene.elements);
    const target = regionAt(centerX, centerY, regions);
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

  /** 文件卡指针按下 —— 捕获指针，记录起点，进入待拖拽状态。 */
  function handlePointerDown(
    e: React.PointerEvent<HTMLDivElement>,
    el: FileElement,
  ): void {
    if (e.button !== 0) return; // 仅响应主键
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({
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
          const isDragging = drag?.elementId === el.id && drag.moved;
          const slotStyle: React.CSSProperties = {
            // 元素在变换容器内按画布坐标绝对定位；容器变换负责缩放/平移。
            left: `${el.x}px`,
            top: `${el.y}px`,
            width: `${el.width}px`,
            height: `${el.height}px`,
          };
          // 拖拽中：用 translate 让卡片实时跟随指针（偏移量为画布单位）。
          if (isDragging && drag) {
            slotStyle.transform = `translate(${drag.offsetX}px, ${drag.offsetY}px)`;
          }
          const className =
            'ov-slot' +
            (isFile ? ' ov-slot--file' : '') +
            (isDragging ? ' ov-slot--dragging' : '');

          return (
            <div
              key={el.id}
              className={className}
              style={slotStyle}
              onPointerDown={
                isFile
                  ? (e) => handlePointerDown(e, el as FileElement)
                  : undefined
              }
              onPointerMove={isFile ? handlePointerMove : undefined}
              onPointerUp={isFile ? handlePointerUp : undefined}
              onPointerCancel={isFile ? handlePointerCancel : undefined}
            >
              {el.type === 'region' ? (
                <RegionCard
                  element={el}
                  highlighted={el.id === dropRegionId}
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
