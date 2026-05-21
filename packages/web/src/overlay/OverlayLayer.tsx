/**
 * 画布渲染层（OverlayLayer）—— 自研画布层的主渲染器，渲染白板全部元素。
 *
 * 坐标系（PRD §11「内容元素层」）：画布坐标 (x,y) 映射到屏幕的公式是
 *      screen = (x + scrollX) * zoom
 * 一个变换容器实现这条公式：
 *      transform: translate(scrollX*zoom, scrollY*zoom) scale(zoom)
 *
 * 渲染范围：图形 / 手绘（ShapeView / DrawView）、文件 / 文件夹 / 区域 / 文本
 * 卡片、连线（ConnectorLayer）、建议卡、Agent 任务卡 —— 同处一棵渲染树、
 * 按 z 统一排序。
 *
 * 交互：
 *  - 创建：创建工具激活时左键拖拽即创建图形 / 手绘 / 文本 / 连线。
 *  - 选择 / 变换：点选出现选择框 + 八向缩放手柄；拖拽移动、手柄缩放。
 *  - 文件卡跨区域拖拽改文件归属（按卡片与区域的重叠面积判定落点）。
 *  - 右键：区域 / 背景弹「整理」菜单；右键框选可整理选中文件。
 *  - 橡皮擦删除、样式面板调样式。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  BoardScene,
  ConnectorElement,
  Element,
  FileElement,
  ParticipantId,
  RegionElement,
  Style,
  SuggestionElement,
  TextElement,
} from '@board/core';
import {
  regionsOf,
  regionForFile,
  arrangeScene,
  growRegions,
  removeElement,
  nextZ,
  createShapeElement,
  createDrawElement,
  createTextElement,
  createConnectorElement,
  DEFAULT_STYLE,
} from '@board/core';
import { useBoard } from '../board/BoardContext';
import { moveFile } from '../server/files';
import { deleteElement } from '../server/client';
import { FileCard } from './FileCard';
import { FolderCard } from './FolderCard';
import { TextCard } from './TextCard';
import { TaskCard } from './TaskCard';
import { SuggestionCard } from './SuggestionCard';
import { RegionCard, type PointerHandlers } from './RegionCard';
import { ConnectorLayer } from './ConnectorLayer';
import { ResizeHandles, type ResizeApi } from './ResizeHandles';
import { StylePanel } from './StylePanel';
import { ShapeView } from '../canvas/ShapeView';
import { DrawView } from '../canvas/DrawView';
import {
  fileBaseName,
  intersectionArea,
  pointInRect,
  smallestHitAt,
  type RectLike,
} from './util';
import './overlay.css';

/** 视口状态 —— 与 canvas/viewport.ts 的 CanvasViewport 同构。 */
export interface OverlayViewport {
  /** 画布平移 X。 */
  scrollX: number;
  /** 画布平移 Y。 */
  scrollY: number;
  /** 缩放系数。 */
  zoom: number;
}

export interface OverlayLayerProps {
  /** 内存中的白板场景（board.json 真相源）。 */
  scene: BoardScene;
  /** 当前视口 —— 由画布外壳下传。 */
  viewport: OverlayViewport;
  /** 当前工具 id —— 决定创建 / 连线 / 橡皮擦模式。 */
  activeTool: string;
  /** 切换当前工具 —— 创建图形后回到选择工具。 */
  onActiveToolChange?: (tool: string) => void;
}

/** 可交互的内容元素（卡片类）—— 可拖拽 / 缩放 / 选中。 */
type ContentElement = Extract<
  Element,
  { type: 'file' | 'folder' | 'region' | 'text' }
>;

/**
 * 本覆盖层负责渲染的全部画布元素 —— 卡片类 + 图形 / 手绘。
 * 自研画布层增量3 起，图形（shape）与手绘（draw）也由覆盖层渲染
 * （ShapeView / DrawView），与卡片同处一棵渲染树、按 z 统一排序，
 * 不再经 Excalidraw。
 */
type CanvasElement = Extract<
  Element,
  { type: 'file' | 'folder' | 'region' | 'text' | 'shape' | 'draw' }
>;

/** 判断元素是否属于本层渲染范围。 */
function isCanvasElement(el: Element): el is CanvasElement {
  return (
    el.type === 'file' ||
    el.type === 'folder' ||
    el.type === 'region' ||
    el.type === 'text' ||
    el.type === 'shape' ||
    el.type === 'draw'
  );
}

/** 拖拽（移动）过程的瞬时状态 —— 文件卡 / 文本卡 / 区域 / 图形手绘共用。 */
interface DragState {
  /** 被拖对象类型：文件卡 / 区域 / 文本卡 / 图形手绘（element）。 */
  kind: 'file' | 'region' | 'text' | 'element';
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
  /** 绝对最小尺寸（按元素类型：区域更大，文件 / 文本 / 文件夹卡更小）。 */
  minW: number;
  minH: number;
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
  /** 右键命中的覆盖层元素 / 连线 id（用于菜单「删除」项）；空白处为 null。 */
  targetId: string | null;
}

/** 启动拖拽 / 框选的位移阈值（屏幕像素）。 */
const DRAG_THRESHOLD_PX = 4;
/**
 * 连线自动吸附的识别宽度（画布单位）—— 也是连线模式下 hover 外包围高亮的
 * 圈宽。须与 bridge `bindDrawnConnectors` 的 TOL、CSS `.ov-connect-target`
 * 的 border-width 三者保持一致。
 */
const CONNECT_TOL = 12;
/** 区域可缩放到的绝对最小尺寸（画布单位）。 */
const REGION_MIN_W = 240;
const REGION_MIN_H = 140;
/** 文件 / 文本 / 文件夹卡的绝对最小尺寸 —— 取得比所有默认卡尺寸更小。 */
const CARD_MIN_W = 100;
const CARD_MIN_H = 40;
/** 区域边缘到内容的留白下限；头部高度 —— 缩放时区域不能压到内容上。 */
const REGION_CONTENT_MARGIN = 16;
const REGION_HEADER_H = 48;

/** 创建工具集 —— 选中其一时画布进入「创建」模式（左键拖拽即创建）。 */
const CREATE_TOOLS: ReadonlySet<string> = new Set([
  'rectangle',
  'ellipse',
  'diamond',
  'arrow',
  'freedraw',
  'text',
]);
/** 点击（拖拽尺寸过小）时图形采用的默认尺寸。 */
const DEFAULT_SHAPE_W = 140;
const DEFAULT_SHAPE_H = 90;
/** 新建文本卡的默认尺寸。 */
const NEW_TEXT_W = 220;
const NEW_TEXT_H = 96;
/** 创建手势视为「有效拖拽」的最小尺寸 / 长度（画布单位）。 */
const CREATE_MIN_DRAG = 8;

/** 创建手势的瞬时状态。 */
interface CreatingState {
  /** 创建中的元素类型。 */
  tool: 'rectangle' | 'ellipse' | 'diamond' | 'arrow' | 'freedraw';
  /** 捕获的指针 id。 */
  pointerId: number;
  /** 起点（画布坐标）。 */
  startX: number;
  startY: number;
  /** 当前点（画布坐标）。 */
  curX: number;
  curY: number;
  /** freedraw 采样点（画布坐标）与逐点压感。 */
  points: Array<[number, number]>;
  pressures: number[];
}

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

/** 按手柄方向与指针位移算出缩放后的矩形（含最小尺寸 / 内容边界 clamp）。 */
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
    const right = Math.max(right0 + dx, r.maxRight, left0 + r.minW);
    x = left0;
    w = right - left0;
  } else if (r.hx === -1) {
    // 拖左边：左边界右移上限为内容左界 / 最小宽度。
    const left = Math.min(left0 + dx, r.minLeft, right0 - r.minW);
    x = left;
    w = right0 - left;
  }

  let y = r.y0;
  let h = r.h0;
  if (r.hy === 1) {
    const bottom = Math.max(bottom0 + dy, r.maxBottom, top0 + r.minH);
    y = top0;
    h = bottom - top0;
  } else if (r.hy === -1) {
    const top = Math.min(top0 + dy, r.minTop, bottom0 - r.minH);
    y = top;
    h = bottom0 - top;
  }
  return { x, y, w, h };
}

/**
 * 元素样式 → 卡槽 CSS 变量覆写。
 *
 * 仅当字段偏离默认值时写入对应变量；未偏离则不写 —— 卡片 CSS 用
 * `var(--ov-xxx, <设计默认>)` 兜底，保证未调样式的卡片保持设计系统原貌。
 */
function styleVars(style: Style): Record<string, string> {
  const vars: Record<string, string> = {};
  if (style.strokeColor !== DEFAULT_STYLE.strokeColor) {
    vars['--ov-stroke'] = style.strokeColor;
  }
  if (style.backgroundColor !== DEFAULT_STYLE.backgroundColor) {
    vars['--ov-fill'] = style.backgroundColor;
  }
  if (style.strokeWidth !== DEFAULT_STYLE.strokeWidth) {
    vars['--ov-stroke-w'] = `${style.strokeWidth}px`;
  }
  if (style.strokeStyle !== DEFAULT_STYLE.strokeStyle) {
    vars['--ov-stroke-style'] = style.strokeStyle;
  }
  return vars;
}

/** 菜单项「删除」的文案，随元素类型而变。 */
function delMenuLabel(el: Element): string {
  if (el.type === 'connector') return '删除连线';
  if (el.type === 'text') return '删除文本卡';
  if (el.type === 'file') return `删除文件「${fileBaseName(el.path)}」`;
  return '删除元素';
}

/** 菜单项「整理」的文案，随作用域而变。 */
function menuLabel(scope: MenuScope): string {
  if (scope.kind === 'region') return `整理「${scope.label}」`;
  if (scope.kind === 'inbox') return '整理白板背景文件';
  return `整理选中的 ${scope.fileIds.length} 个文件`;
}

/**
 * 创建手势的实时预览 —— 用与最终成品同款的渲染器（ShapeView / DrawView）
 * 即时呈现拖拽中的图形 / 手绘；连线用虚线段预览。
 */
function CreationPreview({
  state,
  actorId,
}: {
  state: CreatingState;
  actorId: ParticipantId;
}): JSX.Element | null {
  if (state.tool === 'arrow') {
    const minX = Math.min(state.startX, state.curX);
    const minY = Math.min(state.startY, state.curY);
    const w = Math.abs(state.curX - state.startX);
    const h = Math.abs(state.curY - state.startY);
    const pad = 24;
    return (
      <svg
        className="ov-create-preview"
        style={{ left: `${minX - pad}px`, top: `${minY - pad}px` }}
        width={w + pad * 2}
        height={h + pad * 2}
        aria-hidden="true"
      >
        <line
          x1={state.startX - minX + pad}
          y1={state.startY - minY + pad}
          x2={state.curX - minX + pad}
          y2={state.curY - minY + pad}
          stroke="var(--c-accent)"
          strokeWidth={2}
          strokeDasharray="7 5"
        />
      </svg>
    );
  }
  if (state.tool === 'freedraw') {
    if (state.points.length < 2) return null;
    const xs = state.points.map((p) => p[0]);
    const ys = state.points.map((p) => p[1]);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const w = Math.max(1, Math.max(...xs) - minX);
    const h = Math.max(1, Math.max(...ys) - minY);
    const temp = {
      ...createDrawElement({
        x: minX,
        y: minY,
        width: w,
        height: h,
        createdBy: actorId,
        points: state.points.map((p) => [p[0] - minX, p[1] - minY]),
        pressures: state.pressures,
      }),
      id: '__creating__',
    };
    return (
      <div
        className="ov-slot ov-slot--drawing"
        style={{
          left: `${minX}px`,
          top: `${minY}px`,
          width: `${w}px`,
          height: `${h}px`,
        }}
      >
        <DrawView element={temp} />
      </div>
    );
  }
  // rectangle / ellipse / diamond
  const x = Math.min(state.startX, state.curX);
  const y = Math.min(state.startY, state.curY);
  const w = Math.max(1, Math.abs(state.curX - state.startX));
  const h = Math.max(1, Math.abs(state.curY - state.startY));
  const temp = {
    ...createShapeElement({
      x,
      y,
      width: w,
      height: h,
      createdBy: actorId,
      shape: state.tool,
    }),
    id: '__creating__',
  };
  return (
    <div
      className="ov-slot ov-slot--drawing"
      style={{
        left: `${x}px`,
        top: `${y}px`,
        width: `${w}px`,
        height: `${h}px`,
      }}
    >
      <ShapeView element={temp} />
    </div>
  );
}

export function OverlayLayer({
  scene,
  viewport,
  activeTool,
  onActiveToolChange,
}: OverlayLayerProps): JSX.Element {
  const { scrollX, scrollY, zoom } = viewport;
  const { actorId, connection, serverFiles, tasks, replaceScene } = useBoard();

  // 连线模式：选中箭头 / 线条工具时为 true —— 卡片停止截获指针（好让箭头能
  // 从任意元素上画起 / 画到），并对可连接元素显示高亮。
  const connectMode = activeTool === 'arrow' || activeTool === 'line';

  // 橡皮擦模式：选中橡皮擦工具时为 true —— 点画布元素（图形 / 手绘 / 连线 /
  // 文件卡 / 文本卡）即删除。
  const eraserMode = activeTool === 'eraser';

  // 拖拽 / 缩放瞬时状态；null = 未在进行。
  const [drag, setDrag] = useState<DragState | null>(null);
  const [resize, setResize] = useState<ResizeState | null>(null);
  // 连线模式下鼠标悬停的可连接元素 id —— 高亮加强提示落点。
  const [hoverConnId, setHoverConnId] = useState<string | null>(null);
  // 连线端点拖拽落点所在的可连接元素 id —— 拖拽中临时高亮（同连线创建）。
  const [endpointHover, setEndpointHover] = useState<string | null>(null);
  // 当前选中的内容元素 id —— 选中时显示选择框 + 八向缩放手柄；null = 未选中。
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 右键上下文菜单（屏幕坐标 + 作用域）；null = 未显示。
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    scope: MenuScope;
    /** 右键命中的可删除元素 id（连线 / 文件卡 / 文本卡）；无则 null。 */
    delTargetId: string | null;
  } | null>(null);
  // 右键框选的虚线框（画布坐标矩形）；null = 无。
  const [marquee, setMarquee] = useState<RectLike | null>(null);
  // 创建手势瞬时状态（拖拽创建图形 / 手绘 / 连线）；null = 未在创建。
  const [creating, setCreating] = useState<CreatingState | null>(null);

  // 持有最新场景 / 视口，供事件回调（含挂在 window 上的）读取，避免闭包陈旧。
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const activeToolRef = useRef(activeTool);
  activeToolRef.current = activeTool;
  // 创建状态的 ref 镜像 —— 供挂在 window 上的事件回调读取最新值。
  const creatingRef = useRef<CreatingState | null>(null);
  // 覆盖层根节点 —— 用于换算屏幕↔画布坐标、定位 .board-canvas。
  const rootRef = useRef<HTMLDivElement | null>(null);
  // 右键框选的瞬时跟踪（不触发渲染）。
  const rightPressRef = useRef<RightPress | null>(null);

  // 筛出画布元素并按 z 升序排序 —— 字典序即层级序（与 factory.nextZ 同构）。
  const canvasElements = useMemo<CanvasElement[]>(() => {
    return scene.elements
      .filter(isCanvasElement)
      .sort((a, b) => (a.z < b.z ? -1 : a.z > b.z ? 1 : 0));
  }, [scene.elements]);

  // 连线模式下高亮的「可连接目标」—— 连线 / 建议外的全部元素（含图形）。
  const connectTargets = useMemo(
    () =>
      scene.elements.filter(
        (e) => e.type !== 'connector' && e.type !== 'suggestion',
      ),
    [scene.elements],
  );

  // 建议元素 —— 单独渲染（非可拖拽），并与各自目标元素连线（PRD §7.3）。
  const suggestions = useMemo<SuggestionElement[]>(
    () =>
      scene.elements.filter(
        (e): e is SuggestionElement => e.type === 'suggestion',
      ),
    [scene.elements],
  );

  // 建议 → 目标的连线（画布坐标，中心到中心；目标已删除则不连）。
  const suggestionLinks = useMemo<
    { id: string; x1: number; y1: number; x2: number; y2: number }[]
  >(() => {
    const links: { id: string; x1: number; y1: number; x2: number; y2: number }[] =
      [];
    for (const s of suggestions) {
      const target = scene.elements.find((e) => e.id === s.targetId);
      if (!target) continue;
      links.push({
        id: s.id,
        x1: target.x + target.width / 2,
        y1: target.y + target.height / 2,
        x2: s.x + s.width / 2,
        y2: s.y + s.height / 2,
      });
    }
    return links;
  }, [suggestions, scene.elements]);

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

  // 拖拽 / 缩放进行中的元素的实时矩形 —— 供连线层即时跟随端点：连线随被拖的
  // 卡片、被缩放的区域实时重算。仅含正在变动的元素，其余端点读场景坐标。
  const liveRects = useMemo<Map<string, RectLike>>(() => {
    const m = new Map<string, RectLike>();
    if (drag?.moved) {
      for (const el of scene.elements) {
        if (
          el.id === drag.elementId ||
          (drag.kind === 'region' && el.parentId === drag.elementId)
        ) {
          m.set(el.id, {
            x: el.x + drag.offsetX,
            y: el.y + drag.offsetY,
            width: el.width,
            height: el.height,
          });
        }
      }
    }
    if (resize) {
      m.set(resize.elementId, {
        x: resize.x,
        y: resize.y,
        width: resize.w,
        height: resize.h,
      });
    }
    return m;
  }, [drag, resize, scene.elements]);

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

  // 右键交互（菜单 + 框选）+ 创建手势。在 .board-canvas 上以捕获阶段拦截，
  // 既能盖到整块画布（含空白处），又能抢在浏览器原生右键菜单之前。
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

    // ── 创建手势（图形 / 手绘 / 连线的拖拽创建）────────────────────
    const beginCreate = (
      tool: CreatingState['tool'],
      pointerId: number,
      cx: number,
      cy: number,
      pressure: number,
    ): void => {
      const st: CreatingState = {
        tool,
        pointerId,
        startX: cx,
        startY: cy,
        curX: cx,
        curY: cy,
        points: tool === 'freedraw' ? [[cx, cy]] : [],
        pressures: tool === 'freedraw' ? [pressure || 0.5] : [],
      };
      creatingRef.current = st;
      setCreating(st);
    };
    const onCreateMove = (e: PointerEvent): void => {
      const st = creatingRef.current;
      if (!st || e.pointerId !== st.pointerId) return;
      const c = toCanvas(e.clientX, e.clientY);
      const next: CreatingState = { ...st, curX: c.x, curY: c.y };
      if (st.tool === 'freedraw') {
        next.points = [...st.points, [c.x, c.y]];
        next.pressures = [...st.pressures, e.pressure || 0.5];
      }
      creatingRef.current = next;
      setCreating(next);
    };
    const onCreateUp = (): void => {
      window.removeEventListener('pointermove', onCreateMove);
      window.removeEventListener('pointerup', onCreateUp);
      window.removeEventListener('pointercancel', onCreateUp);
      const st = creatingRef.current;
      creatingRef.current = null;
      setCreating(null);
      if (st) commitCreation(st);
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
          delTargetId: null,
        });
      } else {
        // 单击 —— 按落点决定作用域（区域 / 收件区）
        setMarquee(null);
        setMenu({
          x: e.clientX,
          y: e.clientY,
          scope: scopeAt(p.startCX, p.startCY),
          delTargetId: p.targetId,
        });
      }
    };

    const onDown = (e: PointerEvent): void => {
      // 创建工具激活 + 左键 → 进入创建（优先于选中 / 卡片交互）。
      const tool = activeToolRef.current;
      if (e.button === 0 && CREATE_TOOLS.has(tool)) {
        e.preventDefault();
        e.stopPropagation();
        const c = toCanvas(e.clientX, e.clientY);
        if (tool === 'text') {
          commitText(c.x, c.y);
        } else {
          beginCreate(
            tool as CreatingState['tool'],
            e.pointerId,
            c.x,
            c.y,
            e.pressure,
          );
          window.addEventListener('pointermove', onCreateMove);
          window.addEventListener('pointerup', onCreateUp);
          window.addEventListener('pointercancel', onCreateUp);
        }
        return;
      }
      if (e.button === 0) {
        // 左键：点在内容元素 / 连线 / 手柄 / 样式面板之外 → 取消选中。
        const t = e.target as HTMLElement | null;
        if (
          !t ||
          !t.closest('[data-element-id],[data-connector-id],.ov-style-panel')
        ) {
          setSelectedId(null);
        }
        return;
      }
      if (e.button !== 2) return; // 其余仅处理右键
      e.preventDefault();
      e.stopPropagation();
      setMenu(null);
      setMarquee(null);
      const c = toCanvas(e.clientX, e.clientY);
      // 右键命中的覆盖层元素 / 连线 —— 供菜单「删除」项使用。
      const rt = e.target as HTMLElement | null;
      const rhit = rt?.closest('[data-element-id],[data-connector-id]') ?? null;
      const targetId = rhit
        ? (rhit.getAttribute('data-element-id') ??
          rhit.getAttribute('data-connector-id'))
        : null;
      rightPressRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        startCX: c.x,
        startCY: c.y,
        moved: false,
        targetId,
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };

    const onContextMenu = (e: MouseEvent): void => {
      // 抑制浏览器原生右键菜单 —— Board 用自己的菜单。
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
      window.removeEventListener('pointermove', onCreateMove);
      window.removeEventListener('pointerup', onCreateUp);
      window.removeEventListener('pointercancel', onCreateUp);
    };
  }, []);

  // 连线模式下跟踪鼠标悬停在哪个可连接元素上 —— 高亮加强其落点提示。
  useEffect(() => {
    if (!connectMode) {
      setHoverConnId(null);
      return;
    }
    const onMove = (e: PointerEvent): void => {
      const root = rootRef.current;
      if (!root) return;
      const vp = viewportRef.current;
      const rect = root.getBoundingClientRect();
      const cx = (e.clientX - rect.left) / vp.zoom - vp.scrollX;
      const cy = (e.clientY - rect.top) / vp.zoom - vp.scrollY;
      const targets = sceneRef.current.elements.filter(
        (el) => el.type !== 'connector' && el.type !== 'suggestion',
      );
      const id = smallestHitAt(targets, cx, cy, CONNECT_TOL);
      setHoverConnId((prev) => (prev === id ? prev : id));
    };
    window.addEventListener('pointermove', onMove);
    return () => window.removeEventListener('pointermove', onMove);
  }, [connectMode]);

  // 进连线模式时清掉选中态 —— 连线模式不显示选择框 / 手柄。
  useEffect(() => {
    if (connectMode) setSelectedId(null);
  }, [connectMode]);

  // 选中态键盘操作：Esc 取消选中；Delete / Backspace 删除选中元素。
  useEffect(() => {
    if (!selectedId) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setSelectedId(null);
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // 焦点在输入框 / 可编辑区时不拦截 —— 避免删字符误删元素。
        const ae = document.activeElement as HTMLElement | null;
        if (
          ae &&
          (ae.tagName === 'INPUT' ||
            ae.tagName === 'TEXTAREA' ||
            ae.isContentEditable)
        ) {
          return;
        }
        e.preventDefault();
        void deleteSelected(selectedId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId]);

  // 橡皮擦模式：在 .board-canvas 上以捕获阶段拦截左键按下 —— 命中画布元素
  // （图形 / 手绘 / 连线 / 文件卡 / 文本卡）即删除并吞掉事件（不触发拖拽）；
  // 命中区域 / 文件夹不删（背后是真实文件夹）；点空白处不拦截。
  useEffect(() => {
    if (!eraserMode) return;
    const host = rootRef.current?.parentElement; // .board-canvas
    if (!host) return;
    const onErase = (e: PointerEvent): void => {
      if (e.button !== 0) return;
      const t = e.target as HTMLElement | null;
      const hit = t?.closest('[data-element-id],[data-connector-id]');
      if (!hit) return; // 空白处 —— 不拦截
      const id =
        hit.getAttribute('data-element-id') ??
        hit.getAttribute('data-connector-id');
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      void deleteSelected(id);
    };
    host.addEventListener('pointerdown', onErase, true);
    return () => host.removeEventListener('pointerdown', onErase, true);
  }, [eraserMode]);

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

  // 覆盖层画布操作（移动 / 缩放 / 删除 / 整理）只改内存场景 —— 由 App 层的
  // 操作级自动同步统一 diff 出增量 ops 发往 server（不再各自整场景 PUT，避免
  // 并发写覆盖）。故以下操作均 replaceScene('canvas') 即可，无需主动落盘。

  /**
   * 删除选中的覆盖层元素（连线 / 文本卡 / 文件卡），连带清理悬空引用。
   *
   *  - `file`：背后是真实文件，必须经 server 移入回收站 —— 仅改内存场景会被
   *    下次 reconcile 按磁盘文件复活。
   *  - `connector` / `text`：无文件系统对应物 —— 直接改内存场景并落盘。
   *  - `region` / `folder`：背后是真实文件夹，不在画布删除范围（与 board rm 一致）。
   */
  async function deleteSelected(id: string): Promise<void> {
    const cur = sceneRef.current;
    const el = cur.elements.find((e) => e.id === id);
    if (!el) {
      setSelectedId(null);
      return;
    }
    if (el.type === 'region' || el.type === 'folder') return;
    setSelectedId(null);

    if (el.type === 'file') {
      if (connection !== 'connected') {
        window.alert('未连接 board-server，无法删除文件元素。');
        return;
      }
      // 乐观更新：先本地移除 —— UI 即时反馈，且本地场景不再残留该元素，
      // 否则防抖自动保存会把它写回、覆盖掉 server 的删除。再经 server 端点
      // 把真实文件移入回收站（仅改内存场景不够：文件还在磁盘上，会被下次
      // reconcile 复活）。失败则回滚到删除前场景。
      const { scene: optimistic } = removeElement(cur, id);
      replaceScene(optimistic, 'canvas');
      try {
        await deleteElement(id);
        // server 已落盘并广播 board-changed，SSE 会刷回权威场景。
      } catch (err) {
        replaceScene(cur, 'canvas');
        const msg = err instanceof Error ? err.message : String(err);
        window.alert(`删除失败：${msg}`);
      }
      return;
    }

    // connector / text 等无文件系统对应物 —— 改内存场景，自动同步负责落盘。
    const { scene: next } = removeElement(cur, id);
    replaceScene(next, 'canvas');
  }

  /**
   * 改选中覆盖层元素的统一样式（描边色 / 背景色 / 线宽 / 线型 / 不透明度）。
   * 仅改内存场景 —— 防抖自动保存负责落盘，故拖动不透明度滑杆不会逐次打 server。
   */
  function applyStyle(id: string, patch: Partial<Style>): void {
    const cur = sceneRef.current;
    const ts = new Date().toISOString();
    const next: BoardScene = {
      ...cur,
      elements: cur.elements.map((e): Element =>
        e.id === id
          ? ({
              ...e,
              style: { ...e.style, ...patch },
              updatedBy: actorId,
              updatedAt: ts,
            } as Element)
          : e,
      ),
    };
    replaceScene(next, 'canvas');
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
    // 区域 + 其内全部子元素（含图形 / 手绘）已在场景中整体平移；覆盖层按
    // 场景重渲染即跟随，无需额外同步。
    replaceScene(next, 'canvas');
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
  }

  /**
   * 图形 / 手绘拖拽结束 —— 重新定位并按落点重设所属区域。
   * 与文本卡一致：图形 / 手绘无文件系统对应物，落入区域只改 parentId。
   */
  function finishPlainDrag(d: DragState): void {
    const cur = sceneRef.current;
    const el = cur.elements.find((x) => x.id === d.elementId);
    if (!el) return;
    const finalX = d.startX + d.offsetX;
    const finalY = d.startY + d.offsetY;
    const rect: RectLike = {
      x: finalX,
      y: finalY,
      width: el.width,
      height: el.height,
    };
    const target = regionForCard(rect, regionsOf(cur.elements));
    const patched = patchElement(cur, el.id, {
      x: finalX,
      y: finalY,
      autoPlaced: false,
      parentId: target ? target.id : null,
    });
    const grown = growRegions(patched.elements);
    replaceScene({ ...patched, elements: grown.elements }, 'canvas');
  }

  /** 拖拽结束分发。 */
  function finishDrag(d: DragState): void {
    if (d.kind === 'region') finishRegionDrag(d);
    else if (d.kind === 'text') finishTextDrag(d);
    else if (d.kind === 'element') finishPlainDrag(d);
    else finishFileDrag(d);
  }

  /** 提交一次创建手势 —— 据创建状态造出元素并加入场景。 */
  function commitCreation(st: CreatingState): void {
    const cur = sceneRef.current;
    const z = nextZ(cur.elements);
    let el: Element | null = null;
    if (
      st.tool === 'rectangle' ||
      st.tool === 'ellipse' ||
      st.tool === 'diamond'
    ) {
      let x = Math.min(st.startX, st.curX);
      let y = Math.min(st.startY, st.curY);
      let w = Math.abs(st.curX - st.startX);
      let h = Math.abs(st.curY - st.startY);
      if (w < CREATE_MIN_DRAG && h < CREATE_MIN_DRAG) {
        // 点击而非拖拽 —— 用默认尺寸，以落点为左上角。
        x = st.startX;
        y = st.startY;
        w = DEFAULT_SHAPE_W;
        h = DEFAULT_SHAPE_H;
      }
      el = createShapeElement({
        x,
        y,
        width: Math.max(w, CREATE_MIN_DRAG),
        height: Math.max(h, CREATE_MIN_DRAG),
        createdBy: actorId,
        z,
        shape: st.tool,
      });
    } else if (st.tool === 'freedraw') {
      if (st.points.length < 2) return; // 没画出笔迹
      const xs = st.points.map((p) => p[0]);
      const ys = st.points.map((p) => p[1]);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      const w = Math.max(1, Math.max(...xs) - minX);
      const h = Math.max(1, Math.max(...ys) - minY);
      el = createDrawElement({
        x: minX,
        y: minY,
        width: w,
        height: h,
        createdBy: actorId,
        z,
        points: st.points.map((p) => [p[0] - minX, p[1] - minY]),
        pressures: st.pressures,
      });
    } else {
      // arrow —— 连线；端点命中元素则绑定，否则自由端。
      const dx = st.curX - st.startX;
      const dy = st.curY - st.startY;
      if (Math.hypot(dx, dy) < CREATE_MIN_DRAG) return; // 太短，不成线
      const targets = cur.elements.filter(
        (e) => e.type !== 'connector' && e.type !== 'suggestion',
      );
      let startHit = smallestHitAt(targets, st.startX, st.startY, CONNECT_TOL);
      let endHit = smallestHitAt(targets, st.curX, st.curY, CONNECT_TOL);
      // 两端命中同一元素 —— 多半误吸附，退化为自由连线。
      if (startHit && startHit === endHit) {
        startHit = null;
        endHit = null;
      }
      const minX = Math.min(st.startX, st.curX);
      const minY = Math.min(st.startY, st.curY);
      const sp: [number, number] = [st.startX - minX, st.startY - minY];
      const epPt: [number, number] = [st.curX - minX, st.curY - minY];
      el = {
        ...createConnectorElement({
          x: minX,
          y: minY,
          width: Math.abs(dx),
          height: Math.abs(dy),
          createdBy: actorId,
          z,
          start: { elementId: startHit, anchor: 'auto', point: sp },
          end: { elementId: endHit, anchor: 'auto', point: epPt },
        }),
        // 自由连线由 meta.ex.points 提供折线几何（见 ConnectorLayer）。
        meta: { ex: { points: [sp, epPt] } },
      };
    }
    if (!el) return;
    replaceScene({ ...cur, elements: [...cur.elements, el] }, 'canvas');
    setSelectedId(el.id);
    onActiveToolChange?.('selection');
  }

  /** 文本工具点击 —— 在落点创建一张文本卡。 */
  function commitText(cx: number, cy: number): void {
    const cur = sceneRef.current;
    const el = createTextElement({
      x: cx,
      y: cy,
      width: NEW_TEXT_W,
      height: NEW_TEXT_H,
      createdBy: actorId,
      z: nextZ(cur.elements),
      markdown: '文本',
    });
    replaceScene({ ...cur, elements: [...cur.elements, el] }, 'canvas');
    setSelectedId(el.id);
    onActiveToolChange?.('selection');
  }

  /** 就地编辑提交文本卡正文。 */
  function commitTextMarkdown(id: string, markdown: string): void {
    const cur = sceneRef.current;
    const ts = new Date().toISOString();
    const next: BoardScene = {
      ...cur,
      elements: cur.elements.map((e): Element =>
        e.id === id && e.type === 'text'
          ? ({ ...e, markdown, updatedBy: actorId, updatedAt: ts } as Element)
          : e,
      ),
    };
    replaceScene(next, 'canvas');
  }

  /**
   * 连线端点拖拽落定 —— 对落点做命中测试，重绑该端点（落在空白处则变为
   * 自由端），据落点与另一端重算连线包围盒与折线几何。
   */
  function rebindConnectorEndpoint(
    connId: string,
    which: 'start' | 'end',
    dropX: number,
    dropY: number,
    anchorX: number,
    anchorY: number,
  ): void {
    const cur = sceneRef.current;
    const conn = cur.elements.find(
      (e): e is ConnectorElement => e.id === connId && e.type === 'connector',
    );
    if (!conn) return;
    // 落点命中元素 → 绑定到该元素；否则该端点变为自由端。
    const targets = cur.elements.filter(
      (e) => e.type !== 'connector' && e.type !== 'suggestion',
    );
    const hit = smallestHitAt(targets, dropX, dropY, CONNECT_TOL);
    // 由落点与另一端重算包围盒与 meta.ex.points（相对包围盒左上角）。
    const minX = Math.min(dropX, anchorX);
    const minY = Math.min(dropY, anchorY);
    const dropRel: [number, number] = [dropX - minX, dropY - minY];
    const anchorRel: [number, number] = [anchorX - minX, anchorY - minY];
    const startRel = which === 'start' ? dropRel : anchorRel;
    const endRel = which === 'start' ? anchorRel : dropRel;
    const newStart =
      which === 'start'
        ? { elementId: hit, anchor: 'auto' as const, point: dropRel }
        : { ...conn.start, point: anchorRel };
    const newEnd =
      which === 'end'
        ? { elementId: hit, anchor: 'auto' as const, point: dropRel }
        : { ...conn.end, point: anchorRel };
    const prevEx = conn.meta?.['ex'];
    const exObj =
      prevEx && typeof prevEx === 'object'
        ? (prevEx as Record<string, unknown>)
        : {};
    const next: ConnectorElement = {
      ...conn,
      x: minX,
      y: minY,
      width: Math.abs(dropX - anchorX),
      height: Math.abs(dropY - anchorY),
      start: newStart,
      end: newEnd,
      meta: { ...conn.meta, ex: { ...exObj, points: [startRel, endRel] } },
      updatedBy: actorId,
      updatedAt: new Date().toISOString(),
    };
    replaceScene(
      { ...cur, elements: cur.elements.map((e) => (e.id === connId ? next : e)) },
      'canvas',
    );
  }

  /**
   * 连线端点拖拽时的落点悬停 —— 命中测试落点元素，驱动「可连接元素」外包围
   * 高亮（与连线创建时的悬停高亮一致）。pos 为 null 表示拖拽结束、清除高亮。
   */
  function handleEndpointHover(pos: { x: number; y: number } | null): void {
    if (!pos) {
      setEndpointHover(null);
      return;
    }
    const targets = sceneRef.current.elements.filter(
      (e) => e.type !== 'connector' && e.type !== 'suggestion',
    );
    setEndpointHover(smallestHitAt(targets, pos.x, pos.y, CONNECT_TOL));
  }

  /** 指针按下卡片 / 图形 / 区域头部 —— 捕获指针，记录起点，进入待拖拽状态。 */
  function beginDrag(
    e: React.PointerEvent<HTMLDivElement>,
    el: Element,
    kind: 'file' | 'region' | 'text' | 'element',
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

  /**
   * 指针按下缩放手柄 —— 记录起始矩形、最小尺寸与（区域）内容包围盒边界。
   * 文件 / 文本 / 文件夹卡、图形 / 手绘同样可缩放：它们无子元素，内容边界
   * clamp 自动失效，仅受最小尺寸约束。
   */
  function beginResize(
    e: React.PointerEvent<HTMLDivElement>,
    el: CanvasElement,
    hx: -1 | 0 | 1,
    hy: -1 | 0 | 1,
  ): void {
    if (e.button !== 0) return;
    // 阻止冒泡 —— 否则文件 / 文本卡槽的 onPointerDown 会同时触发拖拽。
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    // 子元素内容包围盒 → 缩放下界（容器不能缩到压住内容）。文件 / 文本 /
    // 文件夹卡无子元素 → cl/cr/ct/cb 保持 ±Infinity，对应 clamp 自然失效。
    const kids = sceneRef.current.elements.filter((x) => x.parentId === el.id);
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
    const isRegion = el.type === 'region';
    setResize({
      elementId: el.id,
      pointerId: e.pointerId,
      hx,
      hy,
      startScreenX: e.clientX,
      startScreenY: e.clientY,
      x0: el.x,
      y0: el.y,
      w0: el.width,
      h0: el.height,
      x: el.x,
      y: el.y,
      w: el.width,
      h: el.height,
      minW: isRegion ? REGION_MIN_W : CARD_MIN_W,
      minH: isRegion ? REGION_MIN_H : CARD_MIN_H,
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
      const cur = sceneRef.current;
      const el = cur.elements.find((x) => x.id === r.elementId);
      if (el && el.type === 'draw' && r.w0 > 0 && r.h0 > 0) {
        // 手绘缩放：采样点按比例缩放，笔迹随包围盒一起变 —— 否则笔迹会
        // 与新包围盒脱节（点是相对原点的固定坐标，不会自动跟着缩放）。
        const sx = r.w / r.w0;
        const sy = r.h / r.h0;
        const scaled: Element = {
          ...el,
          x: r.x,
          y: r.y,
          width: r.w,
          height: r.h,
          autoPlaced: false,
          points: el.points.map((p) => [p[0] * sx, p[1] * sy]),
          updatedBy: actorId,
          updatedAt: new Date().toISOString(),
        };
        replaceScene(
          {
            ...cur,
            elements: cur.elements.map((x) => (x.id === el.id ? scaled : x)),
          },
          'canvas',
        );
      } else {
        const next = patchElement(cur, r.elementId, {
          x: r.x,
          y: r.y,
          width: r.w,
          height: r.h,
          autoPlaced: false,
        });
        replaceScene(next, 'canvas');
      }
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
    closeMenu();
  }

  // 给「可连接元素」画外包围高亮的目标 —— 连线模式取鼠标悬停元素；连线
  // 端点重连拖拽时取拖拽落点元素（与连线创建时的悬停高亮一致）。
  const highlightTargetId = endpointHover ?? (connectMode ? hoverConnId : null);
  const hoverConnEl = highlightTargetId
    ? (connectTargets.find((e) => e.id === highlightTargetId) ?? null)
    : null;

  // 右键菜单的删除目标 —— 右键落在连线 / 文件卡 / 文本卡上时可删。区域 /
  // 文件夹背后是真实文件夹，不在画布删除范围（与 board rm / Delete 键一致），
  // 故不纳入。
  const menuDelEl =
    menu && menu.delTargetId
      ? (scene.elements.find(
          (e) =>
            e.id === menu.delTargetId &&
            (e.type === 'connector' ||
              e.type === 'text' ||
              e.type === 'file'),
        ) ?? null)
      : null;

  // 选中的元素 —— 决定是否浮出样式面板。图形 / 手绘自研画布层后也由本面板
  // 编辑（自研画布层增量5），不再依赖 Excalidraw 属性面板。
  const styleEl = selectedId
    ? (scene.elements.find(
        (e) =>
          e.id === selectedId &&
          (e.type === 'connector' ||
            e.type === 'file' ||
            e.type === 'folder' ||
            e.type === 'region' ||
            e.type === 'text' ||
            e.type === 'shape' ||
            e.type === 'draw'),
      ) ?? null)
    : null;

  // 变换容器样式 —— 实现 screen = (canvas + scroll) * zoom 的视口变换。
  const transformStyle: React.CSSProperties = {
    transform: `translate(${scrollX * zoom}px, ${scrollY * zoom}px) scale(${zoom})`,
    transformOrigin: '0 0',
  };

  return (
    <div
      className={'ov-root' + (connectMode ? ' ov-root--connect' : '')}
      ref={rootRef}
      aria-hidden={
        canvasElements.length === 0 &&
        tasks.length === 0 &&
        suggestions.length === 0
      }
    >
      <div className="ov-transform" style={transformStyle}>
        {/* 建议 → 目标的连线 —— 置于卡片之下，只露出卡片之间的连接段 */}
        {suggestionLinks.length > 0 ? (
          <svg className="ov-links" width="0" height="0" aria-hidden="true">
            {suggestionLinks.map((l) => (
              <line
                key={l.id}
                className="ov-link-line"
                x1={l.x1}
                y1={l.y1}
                x2={l.x2}
                y2={l.y2}
              />
            ))}
          </svg>
        ) : null}

        {canvasElements.map((el) => {
          const isFile = el.type === 'file';
          const isText = el.type === 'text';
          const isShape = el.type === 'shape';
          const isDraw = el.type === 'draw';

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
          // 元素样式 → 卡槽 CSS 变量 + 不透明度（仅偏离默认值的字段才覆写）。
          Object.assign(slotStyle, styleVars(el.style));
          if (el.style.opacity !== DEFAULT_STYLE.opacity) {
            slotStyle.opacity = el.style.opacity / 100;
          }

          const className =
            'ov-slot' +
            (isFile ? ' ov-slot--file' : '') +
            (isText ? ' ov-slot--text' : '') +
            (isShape || isDraw ? ' ov-slot--shape' : '') +
            (el.state === 'draft' ? ' ov-slot--draft' : '') +
            (offset ? ' ov-slot--dragging' : '');

          // 区域头部拖拽手柄（仅区域）—— 兼作区域的点选入口。
          let headerHandlers: PointerHandlers | undefined;
          if (el.type === 'region') {
            const region = el;
            headerHandlers = {
              onPointerDown: (e) => {
                if (e.button === 0) setSelectedId(region.id);
                beginDrag(e, region, 'region');
              },
              onPointerMove: handlePointerMove,
              onPointerUp: handlePointerUp,
              onPointerCancel: handlePointerCancel,
            };
          }
          // 八向缩放 API —— 文件 / 文本 / 文件夹 / 区域所有内容卡通用。
          const resizeApi: ResizeApi = {
            onStart: (e, hx, hy) => beginResize(e, el, hx, hy),
            onMove: handleResizeMove,
            onUp: handleResizeUp,
            onCancel: handleResizeCancel,
          };

          return (
            <div
              key={el.id}
              className={className}
              style={slotStyle}
              data-element-id={el.id}
              onPointerDown={
                el.type === 'region'
                  ? undefined
                  : (e) => {
                      // 点选该元素（显示选择框 / 手柄）并进入待拖拽态。
                      // 区域走头部手柄，不在此。
                      if (e.button !== 0) return;
                      setSelectedId(el.id);
                      if (isFile || isText) {
                        beginDrag(e, el, isFile ? 'file' : 'text');
                      } else if (isShape || isDraw) {
                        beginDrag(e, el, 'element');
                      }
                    }
              }
              onPointerMove={
                el.type === 'region' ? undefined : handlePointerMove
              }
              onPointerUp={el.type === 'region' ? undefined : handlePointerUp}
              onPointerCancel={
                el.type === 'region' ? undefined : handlePointerCancel
              }
            >
              {el.type === 'region' ? (
                <RegionCard
                  element={el}
                  highlighted={el.id === dropRegionId}
                  active={regionActive}
                  headerHandlers={headerHandlers}
                />
              ) : el.type === 'folder' ? (
                <FolderCard element={el} />
              ) : el.type === 'text' ? (
                <TextCard
                  element={el}
                  onCommit={(md) => commitTextMarkdown(el.id, md)}
                />
              ) : el.type === 'shape' ? (
                <ShapeView element={el} />
              ) : el.type === 'draw' ? (
                <DrawView element={el} />
              ) : (
                <FileCard element={el} missing={missingFileIds.has(el.id)} />
              )}
              {/* 选中态：选择框 + 八向缩放手柄（圆点）—— 像 Excalidraw 原生
                  元素那样，选中后才出现包围框与可拖拽的圆点。 */}
              {el.id === selectedId ? (
                <>
                  <div className="ov-select-frame" aria-hidden="true" />
                  <ResizeHandles api={resizeApi} />
                </>
              ) : null}
              {/* 评论角标（PRD §8.4）—— 元素有评论时显示条数 */}
              {(el.comments?.length ?? 0) > 0 ? (
                <div
                  className="ov-comment-badge"
                  title={(el.comments ?? [])
                    .map((c) => `${c.by}: ${c.text}`)
                    .join('\n')}
                >
                  💬 {el.comments?.length}
                </div>
              ) : null}
            </div>
          );
        })}

        {/* 连线层 —— SVG 渲染 connector。置于内容卡之上，否则区域内的连线
            会被区域卡的底色遮住而看不见。连线可点选（选中后 Delete 删除）；
            连线模式下关掉命中区，避免挡住画箭头。 */}
        <ConnectorLayer
          scene={scene}
          liveRects={liveRects}
          selectedId={selectedId}
          onSelect={setSelectedId}
          interactive={!connectMode}
          zoom={zoom}
          onEndpointCommit={rebindConnectorEndpoint}
          onEndpointHover={handleEndpointHover}
        />

        {/* 建议卡片（PRD §7.3）—— 承载 Agent 提议，含同意/拒绝/描述操作。
            与内容卡一致：按 element.style 反映描边色 / 线宽 / 填充 / 不透明度
            （线型固定虚线，是建议卡的身份标识，见 .ov-suggestion）。 */}
        {suggestions.map((s) => {
          const sStyle: React.CSSProperties = {
            left: `${s.x}px`,
            top: `${s.y}px`,
            width: `${s.width}px`,
            height: `${s.height}px`,
          };
          Object.assign(sStyle, styleVars(s.style));
          if (s.style.opacity !== DEFAULT_STYLE.opacity) {
            sStyle.opacity = s.style.opacity / 100;
          }
          return (
            <div
              key={s.id}
              className="ov-slot ov-slot--suggestion"
              data-suggestion-id={s.id}
              style={sStyle}
            >
              <SuggestionCard element={s} />
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

        {/* 连线模式：仅给鼠标悬停的元素画一圈外包围高亮，圈宽 = 自动连接
            识别宽度（CONNECT_TOL）。未悬停任何元素时界面不变。 */}
        {hoverConnEl ? (
          <div
            className="ov-connect-target"
            style={{
              left: `${hoverConnEl.x - CONNECT_TOL}px`,
              top: `${hoverConnEl.y - CONNECT_TOL}px`,
              width: `${hoverConnEl.width + CONNECT_TOL * 2}px`,
              height: `${hoverConnEl.height + CONNECT_TOL * 2}px`,
            }}
            aria-hidden="true"
          />
        ) : null}

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

        {/* 创建预览 —— 拖拽创建图形 / 手绘 / 连线时的实时呈现 */}
        {creating ? (
          <CreationPreview state={creating} actorId={actorId} />
        ) : null}
      </div>

      {/* 样式面板 —— 选中覆盖层元素（连线 / 文件卡 / 文本卡 / 文件夹 / 区域）
          时浮在画布左上角，与原生属性面板对齐。屏幕定位，不进变换容器。 */}
      {styleEl ? (
        <StylePanel
          element={styleEl}
          onChange={(patch) => applyStyle(styleEl.id, patch)}
        />
      ) : null}

      {/* 右键上下文菜单 ——「整理」（作用域由右键位置 / 框选决定）+ 右键
          命中连线 / 文件卡 / 文本卡时附「删除」项 */}
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
              top: `${Math.min(menu.y, window.innerHeight - 96)}px`,
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
            {menuDelEl ? (
              <button
                type="button"
                className="ov-menu__item ov-menu__item--danger"
                onClick={() => {
                  void deleteSelected(menuDelEl.id);
                  closeMenu();
                }}
              >
                <span className="ov-menu__icon" aria-hidden="true">
                  🗑
                </span>
                {delMenuLabel(menuDelEl)}
              </button>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
