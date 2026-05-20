/**
 * DOM 覆盖层 —— 叠在 Excalidraw 画布之上，与画布**共享坐标系**渲染内容元素。
 *
 * 坐标系对齐原理（PRD §11「内容元素层」）：
 *  Excalidraw 把画布坐标 (x,y) 映射到屏幕的公式是
 *      screen = (x + scrollX) * zoom
 *  覆盖层用一个变换容器复刻这条公式：
 *      transform: translate(scrollX*zoom, scrollY*zoom) scale(zoom)
 *
 * 渲染范围（M2）：只渲染 `file` / `folder` / `region` 三类内容元素。
 *
 * 交互：
 *  - 文件卡可拖拽：按卡片与区域的重叠面积判定落点，保留落点（类访达）。
 *  - 区域可拖拽（拖头部）与八向缩放（四角四边手柄）。
 *  - 右键：在区域 / 白板背景上弹出菜单，可「整理」该区域 / 收件区的文件；
 *    右键拖拽框出虚线框 → 菜单可整理框内选中的文件。整理 = 网格自动对齐。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  BoardScene,
  Element,
  FileElement,
  RegionElement,
  TextElement,
} from '@board/core';
import {
  regionsOf,
  regionForFile,
  arrangeScene,
  growRegions,
} from '@board/core';
import { useBoard } from '../board/BoardContext';
import { moveFile } from '../server/files';
import { putScene } from '../server/client';
import { FileCard } from './FileCard';
import { FolderCard } from './FolderCard';
import { TextCard } from './TextCard';
import { TaskCard } from './TaskCard';
import {
  RegionCard,
  type PointerHandlers,
  type RegionResizeApi,
} from './RegionCard';
import {
  fileBaseName,
  intersectionArea,
  pointInRect,
  type RectLike,
} from './util';
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
type ContentElement = Extract<
  Element,
  { type: 'file' | 'folder' | 'region' | 'text' }
>;

/** 判断一个元素是否属于本层渲染范围。 */
function isContentElement(el: Element): el is ContentElement {
  return (
    el.type === 'file' ||
    el.type === 'folder' ||
    el.type === 'region' ||
    el.type === 'text'
  );
}

/** 拖拽（移动）过程的瞬时状态 —— 文件卡 / 文本卡 / 区域共用。 */
interface DragState {
  /** 被拖对象类型：文件卡 / 文本卡 / 区域。 */
  kind: 'file' | 'region' | 'text';
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

/** 右键上下文菜单的作用域 —— 决定「整理」整理哪些文件。 */
type MenuScope =
  | { kind: 'region'; regionId: string; label: string }
  | { kind: 'inbox' }
  | { kind: 'selection'; fileIds: string[] };

/** 右键框选的瞬时状态（plain ref，不进 React state）。 */
interface RightPress {
  /** 按下时的屏幕坐标。 */
  startX: number;
  startY: number;
  /** 按下时的画布坐标。 */
  startCX: number;
  startCY: number;
  /** 是否已越过阈值（成为框选）。 */
  moved: boolean;
}

/** 启动拖拽 / 框选的位移阈值（屏幕像素）。 */
const DRAG_THRESHOLD_PX = 4;
/** 区域可缩放到的绝对最小尺寸（画布单位）。 */
const REGION_MIN_W = 240;
const REGION_MIN_H = 140;
/** 区域边缘到内容的留白下限；头部高度 —— 缩放时区域不能压到内容上。 */
const REGION_CONTENT_MARGIN = 16;
const REGION_HEADER_H = 48;

/** 由两个对角点构造规范化矩形（画布坐标）。 */
function normRect(x0: number, y0: number, x1: number, y1: number): RectLike {
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  };
}

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

/** 菜单项「整理」的文案，随作用域而变。 */
function menuLabel(scope: MenuScope): string {
  if (scope.kind === 'region') return `整理「${scope.label}」`;
  if (scope.kind === 'inbox') return '整理白板背景文件';
  return `整理选中的 ${scope.fileIds.length} 个文件`;
}

export function OverlayLayer({
  scene,
  viewport,
}: OverlayLayerProps): JSX.Element {
  const { scrollX, scrollY, zoom } = viewport;
  const { actorId, connection, serverFiles, tasks, replaceScene } = useBoard();

  // 拖拽 / 缩放瞬时状态；null = 未在进行。
  const [drag, setDrag] = useState<DragState | null>(null);
  const [resize, setResize] = useState<ResizeState | null>(null);
  // 右键上下文菜单（屏幕坐标 + 作用域）；null = 未显示。
  const [menu, setMenu] = useState<{ x: number; y: number; scope: MenuScope } | null>(
    null,
  );
  // 右键框选的虚线框（画布坐标矩形）；null = 无。
  const [marquee, setMarquee] = useState<RectLike | null>(null);

  // 持有最新场景 / 视口，供事件回调（含挂在 window 上的）读取，避免闭包陈旧。
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  // 覆盖层根节点 —— 用于换算屏幕↔画布坐标、定位 .board-canvas。
  const rootRef = useRef<HTMLDivElement | null>(null);
  // 右键框选的瞬时跟踪（不触发渲染）。
  const rightPressRef = useRef<RightPress | null>(null);

  // 筛出内容元素并按 z 升序排序 —— 字典序即层级序（与 factory.nextZ 同构）。
  const contentElements = useMemo<ContentElement[]>(() => {
    return scene.elements
      .filter(isContentElement)
      .sort((a, b) => (a.z < b.z ? -1 : a.z > b.z ? 1 : 0));
  }, [scene.elements]);

  // R6 缺失态：path 不在 server 文件列表里的 file 元素 id 集合。
  // 仅「已连接」时判定 —— 离线模式 serverFiles 为空，不应误判全部缺失。
  const missingFileIds = useMemo<Set<string>>(() => {
    const ids = new Set<string>();
    if (connection !== 'connected') return ids;
    const disk = new Set(serverFiles);
    for (const el of scene.elements) {
      if (el.type === 'file' && !disk.has(el.path)) ids.add(el.id);
    }
    return ids;
  }, [scene.elements, serverFiles, connection]);

  // 拖拽文件 / 文本卡时实时算出落点所在区域 —— 用于高亮提示（区域拖拽不需要）。
  const dropRegionId = useMemo<string | null>(() => {
    if (!drag || !drag.moved || drag.kind === 'region') return null;
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

  // 菜单打开时，Esc 关闭（连同虚线框）。
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setMenu(null);
        setMarquee(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu]);

  // 右键交互（菜单 + 框选）。在 .board-canvas 上以捕获阶段拦截右键，
  // 既能盖到空白画布（Excalidraw 区域），又能抢在 Excalidraw 之前阻止其原生菜单。
  useEffect(() => {
    const host = rootRef.current?.parentElement; // .board-canvas
    if (!host) return;

    /** 屏幕坐标 → 画布坐标。 */
    const toCanvas = (cx: number, cy: number): { x: number; y: number } => {
      const root = rootRef.current;
      const vp = viewportRef.current;
      if (!root) return { x: 0, y: 0 };
      const rect = root.getBoundingClientRect();
      return {
        x: (cx - rect.left) / vp.zoom - vp.scrollX,
        y: (cy - rect.top) / vp.zoom - vp.scrollY,
      };
    };

    /** 画布坐标点落在哪个作用域：命中区域 → 该区域；否则 → 收件区。 */
    const scopeAt = (cx: number, cy: number): MenuScope => {
      let hit: RegionElement | null = null;
      for (const r of regionsOf(sceneRef.current.elements)) {
        if (pointInRect(cx, cy, r) && (!hit || r.z > hit.z)) hit = r;
      }
      return hit
        ? { kind: 'region', regionId: hit.id, label: hit.label || '未命名区域' }
        : { kind: 'inbox' };
    };

    const onMove = (e: PointerEvent): void => {
      const p = rightPressRef.current;
      if (!p) return;
      if (
        !p.moved &&
        Math.hypot(e.clientX - p.startX, e.clientY - p.startY) <=
          DRAG_THRESHOLD_PX
      ) {
        return;
      }
      p.moved = true;
      const c = toCanvas(e.clientX, e.clientY);
      setMarquee(normRect(p.startCX, p.startCY, c.x, c.y));
    };

    const onUp = (e: PointerEvent): void => {
      const p = rightPressRef.current;
      rightPressRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (!p) return;
      if (p.moved) {
        // 框选 —— 选中与虚线框相交的 file 元素
        const c = toCanvas(e.clientX, e.clientY);
        const box = normRect(p.startCX, p.startCY, c.x, c.y);
        const ids = sceneRef.current.elements
          .filter((el) => el.type === 'file' && intersectionArea(box, el) > 0)
          .map((el) => el.id);
        if (ids.length === 0) {
          setMarquee(null);
          return;
        }
        setMarquee(box);
        setMenu({
          x: e.clientX,
          y: e.clientY,
          scope: { kind: 'selection', fileIds: ids },
        });
      } else {
        // 单击 —— 按落点决定作用域（区域 / 收件区）
        setMarquee(null);
        setMenu({
          x: e.clientX,
          y: e.clientY,
          scope: scopeAt(p.startCX, p.startCY),
        });
      }
    };

    const onDown = (e: PointerEvent): void => {
      if (e.button !== 2) return; // 仅右键
      e.preventDefault();
      e.stopPropagation();
      setMenu(null);
      setMarquee(null);
      const c = toCanvas(e.clientX, e.clientY);
      rightPressRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        startCX: c.x,
        startCY: c.y,
        moved: false,
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };

    const onContextMenu = (e: MouseEvent): void => {
      // 抑制浏览器 / Excalidraw 的原生右键菜单 —— Board 用自己的菜单。
      e.preventDefault();
      e.stopPropagation();
    };

    host.addEventListener('pointerdown', onDown, true);
    host.addEventListener('contextmenu', onContextMenu, true);
    return () => {
      host.removeEventListener('pointerdown', onDown, true);
      host.removeEventListener('contextmenu', onContextMenu, true);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

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

  /** 把场景落盘到 server（已连接时）—— 区域移动 / 缩放 / 整理等画布操作的持久化。 */
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

  /** 文本卡拖拽结束 —— 重新定位并按落点重设所属区域（文本无文件系统对应物）。 */
  function finishTextDrag(d: DragState): void {
    const cur = sceneRef.current;
    const el = cur.elements.find(
      (x): x is TextElement => x.id === d.elementId && x.type === 'text',
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
    const target = regionForCard(cardRect, regionsOf(cur.elements));
    const patched = patchElement(cur, el.id, {
      x: finalX,
      y: finalY,
      autoPlaced: false,
      parentId: target ? target.id : null,
    });
    // 文本卡落入区域后，区域增长以包含它（与文件落点一致）。
    const grown = growRegions(patched.elements);
    const next: BoardScene = { ...patched, elements: grown.elements };
    replaceScene(next, 'canvas');
    persist(next, '文本卡片移动');
  }

  /** 拖拽结束分发。 */
  function finishDrag(d: DragState): void {
    if (d.kind === 'region') finishRegionDrag(d);
    else if (d.kind === 'text') finishTextDrag(d);
    else finishFileDrag(d);
  }

  /** 指针按下文件卡 / 区域头部 —— 捕获指针，记录起点，进入待拖拽状态。 */
  function beginDrag(
    e: React.PointerEvent<HTMLDivElement>,
    el: Element,
    kind: 'file' | 'region' | 'text',
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

  /** 关闭上下文菜单（连同虚线框）。 */
  function closeMenu(): void {
    setMenu(null);
    setMarquee(null);
  }

  /** 菜单项「整理」—— 按作用域把文件网格自动对齐。 */
  function handleArrange(scope: MenuScope): void {
    const cur = sceneRef.current;
    let next: BoardScene;
    if (scope.kind === 'region') {
      next = arrangeScene(cur, { containers: [scope.regionId] });
    } else if (scope.kind === 'inbox') {
      next = arrangeScene(cur, { containers: [null] });
    } else {
      next = arrangeScene(cur, { fileIds: new Set(scope.fileIds) });
    }
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
    <div
      className="ov-root"
      ref={rootRef}
      aria-hidden={contentElements.length === 0 && tasks.length === 0}
    >
      <div className="ov-transform" style={transformStyle}>
        {contentElements.map((el) => {
          const isFile = el.type === 'file';
          const isText = el.type === 'text';
          // 文件卡与文本卡可拖拽（重定位 / 改归属）；文件夹、区域另有交互。
          const draggable = isFile || isText;

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
            (isText ? ' ov-slot--text' : '') +
            (el.state === 'draft' ? ' ov-slot--draft' : '') +
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
                draggable
                  ? (e) => beginDrag(e, el, isFile ? 'file' : 'text')
                  : undefined
              }
              onPointerMove={draggable ? handlePointerMove : undefined}
              onPointerUp={draggable ? handlePointerUp : undefined}
              onPointerCancel={draggable ? handlePointerCancel : undefined}
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
              ) : el.type === 'text' ? (
                <TextCard element={el} />
              ) : (
                <FileCard element={el} missing={missingFileIds.has(el.id)} />
              )}
            </div>
          );
        })}

        {/* Pencil 式过程可视化：Agent 任务占位卡（运行时态，不可拖拽） */}
        {tasks.map((task) => (
          <div
            key={task.id}
            className="ov-slot ov-slot--task"
            style={{
              left: `${task.x}px`,
              top: `${task.y}px`,
              width: `${task.width}px`,
              height: `${task.height}px`,
            }}
          >
            <TaskCard task={task} />
          </div>
        ))}

        {/* 右键框选的虚线框 */}
        {marquee ? (
          <div
            className="ov-marquee"
            style={{
              left: `${marquee.x}px`,
              top: `${marquee.y}px`,
              width: `${marquee.width}px`,
              height: `${marquee.height}px`,
            }}
          />
        ) : null}
      </div>

      {/* 右键上下文菜单 —— 唯一项「整理」，作用域由右键位置 / 框选决定 */}
      {menu ? (
        <>
          <div
            className="ov-menu-backdrop"
            onPointerDown={closeMenu}
          />
          <div
            className="ov-menu"
            style={{
              left: `${Math.min(menu.x, window.innerWidth - 220)}px`,
              top: `${Math.min(menu.y, window.innerHeight - 56)}px`,
            }}
          >
            <button
              type="button"
              className="ov-menu__item"
              onClick={() => handleArrange(menu.scope)}
            >
              <span className="ov-menu__icon" aria-hidden="true">
                ▦
              </span>
              {menuLabel(menu.scope)}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
