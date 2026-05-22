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
  ArrowHead,
  BoardScene,
  ConnectorElement,
  ConnectorRouting,
  DrawElement,
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
  newElementId,
  newGroupId,
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
  segmentIntersectsRect,
  smallestHitAt,
  type RectLike,
} from './util';
import { computeSnap, type SnapGuide } from './snap';
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

/**
 * 缩放进行中的手绘元素 —— 采样点按比例实时缩放，使笔迹随包围盒一起变
 * （否则缩放过程中笔迹与新尺寸脱节，松手才跳到位）。
 */
function liveDrawEl(el: DrawElement, r: ResizeState): DrawElement {
  const sx = r.w0 > 0 ? r.w / r.w0 : 1;
  const sy = r.h0 > 0 ? r.h / r.h0 : 1;
  return {
    ...el,
    width: r.w,
    height: r.h,
    points: el.points.map((p): [number, number] => [p[0] * sx, p[1] * sy]),
  };
}

/**
 * 连线目标外包围高亮 —— 按元素形状套一圈半透明高亮环，贴着元素外缘。
 * 矩形 / 卡片 / 手绘用圆角矩形环；图形按其形状（椭圆 → 椭圆环、菱形 →
 * 菱形环）。环宽 = 自动连接识别宽度（CONNECT_TOL）、内缘贴元素边。
 */
function ConnectTargetRing({ element }: { element: Element }): JSX.Element {
  const w = element.width;
  const h = element.height;
  const half = CONNECT_TOL / 2;
  // 描边居中于路径：路径外扩 half，描边宽 CONNECT_TOL → 环内缘恰贴元素边。
  const common = {
    className: 'ov-connect-target__shape',
    fill: 'none',
    strokeWidth: CONNECT_TOL,
  } as const;
  let ring: JSX.Element;
  if (element.type === 'shape' && element.shape === 'ellipse') {
    ring = (
      <ellipse
        cx={w / 2}
        cy={h / 2}
        rx={w / 2 + half}
        ry={h / 2 + half}
        {...common}
      />
    );
  } else if (element.type === 'shape' && element.shape === 'diamond') {
    ring = (
      <polygon
        points={`${w / 2},${-half} ${w + half},${h / 2} ${w / 2},${h + half} ${-half},${h / 2}`}
        {...common}
      />
    );
  } else {
    ring = (
      <rect
        x={-half}
        y={-half}
        width={w + CONNECT_TOL}
        height={h + CONNECT_TOL}
        rx={8}
        {...common}
      />
    );
  }
  return (
    <svg
      className="ov-connect-target"
      style={{ left: `${element.x}px`, top: `${element.y}px` }}
      width={w}
      height={h}
      aria-hidden="true"
    >
      {ring}
    </svg>
  );
}

/**
 * 选中框 —— 选中元素时套一圈细描边，按元素形状走（矩形 / 椭圆 / 菱形），
 * 外扩 4px 贴着元素外缘。渲染在卡槽内，故按卡槽（含缩放中的实时尺寸）定位。
 */
function SelectionFrame({
  element,
  width,
  height,
}: {
  element: Element;
  width: number;
  height: number;
}): JSX.Element {
  const M = 4; // 外扩边距
  const w = width;
  const h = height;
  const common = {
    className: 'ov-select-frame__shape',
    fill: 'none',
    strokeWidth: 1.5,
  } as const;
  let frame: JSX.Element;
  if (element.type === 'shape' && element.shape === 'ellipse') {
    frame = (
      <ellipse cx={w / 2} cy={h / 2} rx={w / 2 + M} ry={h / 2 + M} {...common} />
    );
  } else if (element.type === 'shape' && element.shape === 'diamond') {
    frame = (
      <polygon
        points={`${w / 2},${-M} ${w + M},${h / 2} ${w / 2},${h + M} ${-M},${h / 2}`}
        {...common}
      />
    );
  } else {
    frame = (
      <rect x={-M} y={-M} width={w + 2 * M} height={h + 2 * M} rx={10} {...common} />
    );
  }
  return (
    <svg className="ov-select-frame" width={w} height={h} aria-hidden="true">
      {frame}
    </svg>
  );
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
  /**
   * 被拖对象类型：文件卡 / 区域 / 文本卡 / 图形手绘（element）/ 多选整组
   * （group）。group 为多选整组拖拽 —— 仅按偏移整体平移，落定走 finishGroupDrag。
   */
  kind: 'file' | 'region' | 'text' | 'element' | 'group';
  /** 被拖元素 id（group 时为按下的那个元素）。 */
  elementId: string;
  /**
   * 随本次拖拽一起平移的全部元素 id —— 单拖为 {elementId}；区域拖拽含其子
   * 元素；整组拖拽为整个选区（含其中区域的子元素）。渲染与连线层据此实时跟随。
   */
  memberIds: ReadonlySet<string>;
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

/** 旋转过程的瞬时状态。 */
interface RotateState {
  /** 被旋转的元素 id。 */
  elementId: string;
  /** 捕获的指针 id。 */
  pointerId: number;
  /** 元素中心（画布坐标）—— 旋转锚点。 */
  cx: number;
  cy: number;
  /** 当前角度（弧度，随指针实时更新）。 */
  angle: number;
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

/** 左键空白处框选的瞬时状态（plain ref，不进 React state）。 */
interface LeftPress {
  /** 按下时的屏幕坐标。 */
  startX: number;
  startY: number;
  /** 按下时的画布坐标。 */
  startCX: number;
  startCY: number;
  /** 是否已越过阈值（成为框选）。 */
  moved: boolean;
  /** 是否叠加到既有选区（按下时 shift 键按住）。 */
  additive: boolean;
}

/**
 * 左键框选中按「包围盒相交」判定的元素类型。连线另按线段相交、区域另按
 * 「完整罩住」单独判定（见 onLeftUp）；建议不纳入框选。
 */
const MARQUEE_TYPES: ReadonlySet<string> = new Set([
  'shape',
  'draw',
  'text',
  'file',
  'folder',
]);

/** 启动拖拽 / 框选的位移阈值（屏幕像素）。 */
const DRAG_THRESHOLD_PX = 4;
/** 拖拽对齐吸附的识别阈值（屏幕像素，运行时按 zoom 折算到画布单位）。 */
const SNAP_THRESHOLD_PX = 6;
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
/** 粘贴 / 原地复制时相对源元素的偏移（画布单位）—— 连续粘贴逐次叠加错开。 */
const PASTE_OFFSET = 24;
/** 可被复制 / 粘贴的元素类型 —— 文件 / 文件夹 / 区域背后是真实文件系统条目，不复制。 */
const COPYABLE_TYPES: ReadonlySet<string> = new Set([
  'shape',
  'draw',
  'text',
  'connector',
]);

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
 * 连线两端的当前画布坐标 —— 框选命中测试用。
 *
 * 绑定端取所连元素中心（连线实际贴元素边缘，中心落在元素内、足够近似）；
 * 自由端取连线自身几何（meta.ex.points，缺省用包围盒对角）。不读连线存储的
 * x/y/width/height —— 绑定端元素移动后那份包围盒会过期。
 */
function connectorAnchors(
  conn: ConnectorElement,
  elements: readonly Element[],
): { a: { x: number; y: number }; b: { x: number; y: number } } {
  const ex = conn.meta?.['ex'];
  const raw =
    ex && typeof ex === 'object'
      ? (ex as { points?: unknown }).points
      : undefined;
  const pts = Array.isArray(raw) ? (raw as Array<[number, number]>) : null;
  const p0 = pts && pts.length >= 1 ? pts[0] : null;
  const pN = pts && pts.length >= 2 ? pts[pts.length - 1] : null;
  const freeA = p0
    ? { x: conn.x + p0[0], y: conn.y + p0[1] }
    : { x: conn.x, y: conn.y };
  const freeB = pN
    ? { x: conn.x + pN[0], y: conn.y + pN[1] }
    : { x: conn.x + conn.width, y: conn.y + conn.height };
  const startEl = conn.start.elementId
    ? elements.find((e) => e.id === conn.start.elementId)
    : undefined;
  const endEl = conn.end.elementId
    ? elements.find((e) => e.id === conn.end.elementId)
    : undefined;
  return {
    a: startEl
      ? { x: startEl.x + startEl.width / 2, y: startEl.y + startEl.height / 2 }
      : freeA,
    b: endEl
      ? { x: endEl.x + endEl.width / 2, y: endEl.y + endEl.height / 2 }
      : freeB,
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
  // 当前拖拽的对齐参考线 —— 拖拽进行中实时刷新，落定 / 取消时清空。
  const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([]);
  // 正在就地编辑标签的图形 id —— 双击图形进入；null = 无。双击事件经指针
  // 捕获落在卡槽上，故由卡槽 onDoubleClick 触发、状态提到本层。
  const [editingLabelId, setEditingLabelId] = useState<string | null>(null);
  const [resize, setResize] = useState<ResizeState | null>(null);
  // 旋转瞬时状态；null = 未在旋转。
  const [rotate, setRotate] = useState<RotateState | null>(null);
  // 连线模式下鼠标悬停的可连接元素 id —— 高亮加强提示落点。
  const [hoverConnId, setHoverConnId] = useState<string | null>(null);
  // 连线端点拖拽落点所在的可连接元素 id —— 拖拽中临时高亮（同连线创建）。
  const [endpointHover, setEndpointHover] = useState<string | null>(null);
  // 当前选中的元素 id 集合 —— 空集 = 未选中；选中态显示选择框，单选（size===1）
  // 才出八向缩放手柄与样式面板，多选可整组拖拽 / 批量删除。
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // 左键空白处框选的虚线框（画布坐标矩形）；null = 未在框选。
  const [selectMarquee, setSelectMarquee] = useState<RectLike | null>(null);
  // 右键上下文菜单（屏幕坐标 + 作用域）；null = 未显示。
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    scope: MenuScope;
    /** 右键是否落在元素上 —— 决定菜单是否显示「编组 / 取消编组 / 删除」选区操作项。 */
    onElement: boolean;
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
  // 左键空白处框选的瞬时跟踪（不触发渲染）。
  const leftPressRef = useRef<LeftPress | null>(null);
  // 选区的 ref 镜像 —— 供挂在 window 上的框选回调读取最新值。
  const selectedIdsRef = useRef<ReadonlySet<string>>(selectedIds);
  selectedIdsRef.current = selectedIds;
  // 应用内剪贴板 —— 持有复制 / 剪切的元素快照（深拷贝）。pasteCount 记连续
  // 粘贴次数，使每次粘贴相对源逐级错开；新一次复制时归零。
  const clipboardRef = useRef<{ elements: Element[]; pasteCount: number }>({
    elements: [],
    pasteCount: 0,
  });
  // 连线本体拖拽的瞬时状态镜像 —— 连线是 SVG、走 window 监听，回调据此读最新值。
  const connDragRef = useRef<DragState | null>(null);

  /** 选中单个元素（替换当前选区）—— 用于新建元素等「就选它本身」的场景。 */
  function selectOnly(id: string): void {
    setSelectedIds(new Set([id]));
  }
  /**
   * 某元素所属编组（最外层）的全部成员 id —— 未编组则仅含其自身。
   * 点选 / 框选据此把选区扩展为整组（groupIds 末项为最外层组）。
   */
  function groupMembersOf(id: string): Set<string> {
    const cur = sceneRef.current;
    const el = cur.elements.find((e) => e.id === id);
    const gids = el?.groupIds;
    const outer = gids && gids.length > 0 ? gids[gids.length - 1] : null;
    if (!outer) return new Set([id]);
    const set = new Set<string>();
    for (const e of cur.elements) {
      if (e.groupIds?.includes(outer)) set.add(e.id);
    }
    return set;
  }
  /** 把一组元素 id 扩展为「连同各自所属编组的全部成员」。 */
  function expandToGroups(ids: Iterable<string>): Set<string> {
    const out = new Set<string>();
    for (const id of ids) {
      for (const m of groupMembersOf(id)) out.add(m);
    }
    return out;
  }
  /** 选中某元素 —— 若它属于编组则连同整组一起选中。 */
  function selectGroupOf(id: string): void {
    setSelectedIds(groupMembersOf(id));
  }
  /** shift 点选：把某元素（连同其所属编组）整体加入 / 移出选区。 */
  function toggleInSelection(id: string): void {
    const gset = groupMembersOf(id);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allIn = [...gset].every((g) => next.has(g));
      for (const g of gset) {
        if (allIn) next.delete(g);
        else next.add(g);
      }
      return next;
    });
  }
  /** 清空选区。 */
  function clearSelection(): void {
    setSelectedIds((prev) => (prev.size === 0 ? prev : new Set()));
  }

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
        if (drag.memberIds.has(el.id)) {
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

  // 选区涉及的各编组的整体包围盒 —— 选中编组时套一圈虚线框，与逐元素选择框
  // 区分（直观显示「这是一个组」）。拖拽中按 liveRects 实时跟随。
  const groupBoxes = useMemo<Array<{ gid: string } & RectLike>>(() => {
    if (selectedIds.size === 0) return [];
    const byId = new Map(scene.elements.map((e) => [e.id, e] as const));
    const gids = new Set<string>();
    for (const id of selectedIds) {
      const g = byId.get(id)?.groupIds;
      if (g && g.length > 0) gids.add(g[g.length - 1]!);
    }
    if (gids.size === 0) return [];
    const out: Array<{ gid: string } & RectLike> = [];
    for (const gid of gids) {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const e of scene.elements) {
        if (!e.groupIds?.includes(gid)) continue;
        const r = liveRects.get(e.id) ?? {
          x: e.x,
          y: e.y,
          width: e.width,
          height: e.height,
        };
        x0 = Math.min(x0, r.x);
        y0 = Math.min(y0, r.y);
        x1 = Math.max(x1, r.x + r.width);
        y1 = Math.max(y1, r.y + r.height);
      }
      if (x0 < x1 && y0 < y1) {
        out.push({ gid, x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
      }
    }
    return out;
  }, [selectedIds, scene.elements, liveRects]);

  // 拖拽文件 / 文本卡时实时算出落点所在区域 —— 用于高亮提示（区域拖拽不需要）。
  const dropRegionId = useMemo<string | null>(() => {
    if (!drag || !drag.moved) return null;
    // 区域拖拽 / 整组拖拽不重设归属 —— 不显示落点高亮。
    if (drag.kind === 'region' || drag.kind === 'group') return null;
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
          onElement: false,
        });
      } else {
        // 单击 —— 命中元素则按编组规则确保其选中（菜单的选区操作对象 = 当前
        // 选区），整理作用域按落点决定（区域 / 收件区）。
        setMarquee(null);
        if (p.targetId && !selectedIdsRef.current.has(p.targetId)) {
          selectGroupOf(p.targetId);
        }
        setMenu({
          x: e.clientX,
          y: e.clientY,
          scope: scopeAt(p.startCX, p.startCY),
          onElement: !!p.targetId,
        });
      }
    };

    // ── 左键空白处框选（多选）──────────────────────────────────
    const onLeftMove = (e: PointerEvent): void => {
      const p = leftPressRef.current;
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
      setSelectMarquee(normRect(p.startCX, p.startCY, c.x, c.y));
    };

    const onLeftUp = (e: PointerEvent): void => {
      const p = leftPressRef.current;
      leftPressRef.current = null;
      window.removeEventListener('pointermove', onLeftMove);
      window.removeEventListener('pointerup', onLeftUp);
      setSelectMarquee(null);
      if (!p || !p.moved) return; // 只是点击 —— 选区已在 onDown 处理
      const c = toCanvas(e.clientX, e.clientY);
      const box = normRect(p.startCX, p.startCY, c.x, c.y);
      // 与虚线框相交的元素：卡片 / 图形 / 手绘按包围盒判定，连线按线段判定，
      // 区域须被虚线框完整罩住才选中（建议不纳入框选）。
      const els = sceneRef.current.elements;
      const hits: string[] = [];
      for (const el of els) {
        if (el.locked) continue; // 锁定元素不被框选纳入
        if (MARQUEE_TYPES.has(el.type)) {
          if (intersectionArea(box, el) > 0) hits.push(el.id);
        } else if (el.type === 'connector') {
          const { a, b } = connectorAnchors(el, els);
          if (segmentIntersectsRect(a, b, box)) hits.push(el.id);
        } else if (el.type === 'region') {
          // 区域是大容器 —— 须完整罩住才选中，否则在区域内框选卡片会误选区域。
          if (
            box.x <= el.x &&
            box.y <= el.y &&
            box.x + box.width >= el.x + el.width &&
            box.y + box.height >= el.y + el.height
          ) {
            hits.push(el.id);
          }
        }
      }
      // 命中编组成员即连同整组一并选中。
      setSelectedIds((prev) => {
        const next = p.additive ? new Set(prev) : new Set<string>();
        for (const id of expandToGroups(hits)) next.add(id);
        return next;
      });
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
        // 左键空白处：点在内容元素 / 连线 / 手柄 / 样式面板上 → 交给各自处理。
        const t = e.target as HTMLElement | null;
        const onEl =
          !!t &&
          !!t.closest(
            '[data-element-id],[data-connector-id],.ov-style-panel,' +
              '.ov-menu,.ov-menu-backdrop',
          );
        if (onEl) return;
        // 空白处：非 shift 即清空选区；选择工具下左键拖拽 = 框选多选。
        if (!e.shiftKey) {
          setSelectedIds(new Set());
          setSelectMarquee(null);
        }
        if (activeToolRef.current === 'selection') {
          const c = toCanvas(e.clientX, e.clientY);
          leftPressRef.current = {
            startX: e.clientX,
            startY: e.clientY,
            startCX: c.x,
            startCY: c.y,
            moved: false,
            additive: e.shiftKey,
          };
          window.addEventListener('pointermove', onLeftMove);
          window.addEventListener('pointerup', onLeftUp);
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
      window.removeEventListener('pointermove', onLeftMove);
      window.removeEventListener('pointerup', onLeftUp);
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
    if (connectMode) setSelectedIds(new Set());
  }, [connectMode]);

  // 选中态键盘操作：Esc 取消选中；Delete / Backspace 删除选中元素（含多选批量）。
  useEffect(() => {
    if (selectedIds.size === 0) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setSelectedIds(new Set());
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
        void deleteSelectedSet(selectedIds);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedIds]);

  // 复制 / 剪切 / 粘贴 / 原地复制（Ctrl/⌘+C/X/V/D）—— 始终挂载（粘贴无需选区）。
  // 依赖 connection：剪切含文件元素时 deleteSelectedSet 需读最新连接态。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (
        k !== 'c' &&
        k !== 'x' &&
        k !== 'v' &&
        k !== 'd' &&
        k !== 'g' &&
        k !== ']' &&
        k !== '['
      ) {
        return;
      }
      // 输入框 / 文本域 / 可编辑区聚焦时让位给原生复制粘贴。
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
      if (k === 'c') copySelection();
      else if (k === 'x') cutSelection();
      else if (k === 'v') pasteClipboard();
      else if (k === 'd') duplicateSelection();
      else if (k === 'g') {
        // Ctrl+G 成组 / Ctrl+Shift+G 取消编组。
        if (e.shiftKey) ungroupSelection();
        else groupSelection();
      } else if (k === ']') {
        // Ctrl+] 上移一层 / Ctrl+Shift+] 置顶。
        reorderSelection(e.shiftKey ? 'front' : 'forward');
      } else if (k === '[') {
        // Ctrl+[ 下移一层 / Ctrl+Shift+[ 置底。
        reorderSelection(e.shiftKey ? 'back' : 'backward');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [connection]);

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
      Pick<
        Element,
        'x' | 'y' | 'width' | 'height' | 'angle' | 'autoPlaced' | 'parentId'
      >
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
      clearSelection();
      return;
    }
    if (el.type === 'region' || el.type === 'folder') return;
    clearSelection();

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
   * 批量删除一组选中元素 —— 多选 Delete 用。
   *
   * 与单删一致：区域 / 文件夹背后是真实文件夹，不在画布删除范围；连线 / 文本 /
   * 图形 / 手绘一次性从内存场景移除；文件元素背后是真实文件，乐观移除后逐个经
   * server 移入回收站。removeElement 连带清理指向被删元素的悬空连线。
   */
  async function deleteSelectedSet(ids: ReadonlySet<string>): Promise<void> {
    const cur = sceneRef.current;
    const els = [...ids]
      .map((id) => cur.elements.find((e) => e.id === id))
      .filter(
        (e): e is Element =>
          !!e && e.type !== 'region' && e.type !== 'folder' && !e.locked,
      );
    clearSelection();
    if (els.length === 0) return;
    const files = els.filter((e): e is FileElement => e.type === 'file');
    const others = els.filter((e) => e.type !== 'file');
    const canDeleteFiles = connection === 'connected';
    // 先在内存场景里移除可删元素（removeElement 连带清理悬空连线引用）。
    let working = cur;
    for (const e of others) working = removeElement(working, e.id).scene;
    if (canDeleteFiles) {
      for (const f of files) working = removeElement(working, f.id).scene;
    }
    if (working !== cur) replaceScene(working, 'canvas');
    if (files.length > 0 && !canDeleteFiles) {
      window.alert('未连接 board-server，文件元素未删除。');
      return;
    }
    // 文件元素背后是真实文件 —— 逐个经 server 移入回收站。
    for (const f of files) {
      try {
        await deleteElement(f.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        window.alert(`删除文件「${fileBaseName(f.path)}」失败：${msg}`);
      }
    }
  }

  /**
   * 把一组元素克隆为可加入场景的新元素 —— 赋新 id、按 (dx,dy) 偏移、叠到顶层。
   *
   *  - 连线端点 / parentId 中的元素引用：指向被一同克隆的元素则改指其新 id，
   *    否则置空（不让粘贴出的连线连回原件、不误挂到原区域）。
   *  - 按源 z 升序克隆，保持粘贴元素之间的相对层级。
   */
  function cloneElements(sources: Element[], dx: number, dy: number): Element[] {
    const cur = sceneRef.current;
    const ordered = [...sources].sort((a, b) =>
      a.z < b.z ? -1 : a.z > b.z ? 1 : 0,
    );
    const idMap = new Map<string, string>();
    for (const s of ordered) idMap.set(s.id, newElementId());
    // 编组 id 重映射 —— 被一同克隆的编组在副本里形成「平行的新组」，
    // 不与原件同组（否则点粘贴出的副本会连原件一起选中）。
    const groupMap = new Map<string, string>();
    for (const s of ordered) {
      for (const g of s.groupIds ?? []) {
        if (!groupMap.has(g)) groupMap.set(g, newGroupId());
      }
    }
    let zBase = parseInt(nextZ(cur.elements), 36);
    if (Number.isNaN(zBase)) zBase = 0;
    const ts = new Date().toISOString();
    return ordered.map((s, i): Element => {
      const cloned = JSON.parse(JSON.stringify(s)) as Element;
      cloned.id = idMap.get(s.id)!;
      cloned.x = s.x + dx;
      cloned.y = s.y + dy;
      cloned.z = (zBase + i).toString(36).padStart(8, '0');
      cloned.parentId =
        s.parentId && idMap.has(s.parentId) ? idMap.get(s.parentId)! : null;
      if (cloned.groupIds && cloned.groupIds.length > 0) {
        cloned.groupIds = cloned.groupIds.map((g) => groupMap.get(g) ?? g);
      }
      cloned.autoPlaced = false;
      cloned.createdBy = actorId;
      cloned.updatedBy = actorId;
      cloned.createdAt = ts;
      cloned.updatedAt = ts;
      if (cloned.type === 'connector') {
        const remapEp = (
          ep: ConnectorElement['start'],
        ): ConnectorElement['start'] => ({
          ...ep,
          elementId:
            ep.elementId && idMap.has(ep.elementId)
              ? idMap.get(ep.elementId)!
              : null,
        });
        cloned.start = remapEp(cloned.start);
        cloned.end = remapEp(cloned.end);
      }
      return cloned;
    });
  }

  /** 选区中可复制的元素 —— 文件 / 文件夹 / 区域背后是真实文件系统条目，不复制。 */
  function copyableSelection(): Element[] {
    const cur = sceneRef.current;
    return [...selectedIdsRef.current]
      .map((id) => cur.elements.find((e) => e.id === id))
      .filter((e): e is Element => !!e && COPYABLE_TYPES.has(e.type));
  }

  /** Ctrl/⌘+C —— 把选区中可复制元素的快照存入剪贴板。 */
  function copySelection(): void {
    const picked = copyableSelection();
    if (picked.length === 0) return;
    clipboardRef.current = {
      elements: picked.map((e) => JSON.parse(JSON.stringify(e)) as Element),
      pasteCount: 0,
    };
  }

  /** Ctrl/⌘+X —— 复制选区后删除选区。 */
  function cutSelection(): void {
    copySelection();
    void deleteSelectedSet(selectedIdsRef.current);
  }

  /** Ctrl/⌘+V —— 把剪贴板内容克隆进场景（连续粘贴逐级错开），选中粘贴结果。 */
  function pasteClipboard(): void {
    const clip = clipboardRef.current;
    if (clip.elements.length === 0) return;
    clip.pasteCount += 1;
    const off = PASTE_OFFSET * clip.pasteCount;
    const clones = cloneElements(clip.elements, off, off);
    const cur = sceneRef.current;
    replaceScene({ ...cur, elements: [...cur.elements, ...clones] }, 'canvas');
    setSelectedIds(new Set(clones.map((c) => c.id)));
  }

  /** Ctrl/⌘+D —— 原地复制选区（相对源偏移一档），不经剪贴板。 */
  function duplicateSelection(): void {
    const picked = copyableSelection();
    if (picked.length === 0) return;
    const clones = cloneElements(picked, PASTE_OFFSET, PASTE_OFFSET);
    const cur = sceneRef.current;
    replaceScene({ ...cur, elements: [...cur.elements, ...clones] }, 'canvas');
    setSelectedIds(new Set(clones.map((c) => c.id)));
  }

  /**
   * Ctrl/⌘+G —— 把当前选区编为一组：给每个选中元素的 groupIds 追加同一个
   * 新组 id（追加即成为最外层组，支持嵌套）。选区不足 2 个不成组。
   */
  function groupSelection(): void {
    const sel = selectedIdsRef.current;
    if (sel.size < 2) return;
    const gid = newGroupId();
    const cur = sceneRef.current;
    const ts = new Date().toISOString();
    const elements = cur.elements.map((e): Element =>
      sel.has(e.id)
        ? ({
            ...e,
            groupIds: [...(e.groupIds ?? []), gid],
            updatedBy: actorId,
            updatedAt: ts,
          } as Element)
        : e,
    );
    replaceScene({ ...cur, elements }, 'canvas');
  }

  /**
   * Ctrl/⌘+Shift+G —— 解散选区中元素的最外层编组（弹出 groupIds 末项）。
   * 嵌套编组只解最外一层；未编组元素不受影响。
   */
  function ungroupSelection(): void {
    const sel = selectedIdsRef.current;
    if (sel.size === 0) return;
    const cur = sceneRef.current;
    const ts = new Date().toISOString();
    let changed = false;
    const elements = cur.elements.map((e): Element => {
      if (!sel.has(e.id) || !e.groupIds || e.groupIds.length === 0) return e;
      changed = true;
      const rest = e.groupIds.slice(0, -1);
      return {
        ...e,
        groupIds: rest.length > 0 ? rest : undefined,
        updatedBy: actorId,
        updatedAt: ts,
      } as Element;
    });
    if (changed) replaceScene({ ...cur, elements }, 'canvas');
  }

  /**
   * 改整个选区的统一样式（描边色 / 背景色 / 线宽 / 线型 / 不透明度）——
   * 单选改一个、多选批量改全部。仅改内存场景，防抖自动保存负责落盘，
   * 故拖动不透明度滑杆不会逐次打 server。
   */
  function applyStyleToSelection(patch: Partial<Style>): void {
    const cur = sceneRef.current;
    const sel = selectedIdsRef.current;
    if (sel.size === 0) return;
    const ts = new Date().toISOString();
    const next: BoardScene = {
      ...cur,
      elements: cur.elements.map((e): Element =>
        sel.has(e.id)
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

  /**
   * 图形 / 连线标签提交 —— 写回 connector 的 `label`；文本去空后为空则置
   * label 为 null（无标签）。
   */
  function commitConnectorLabel(id: string, text: string): void {
    const cur = sceneRef.current;
    const ts = new Date().toISOString();
    const next: BoardScene = {
      ...cur,
      elements: cur.elements.map((e): Element =>
        e.id === id && e.type === 'connector'
          ? ({
              ...e,
              label: text.trim() ? { text } : null,
              updatedBy: actorId,
              updatedAt: ts,
            } as Element)
          : e,
      ),
    };
    replaceScene(next, 'canvas');
  }

  /**
   * 改选区内连线的端点箭头 / 路由方式 —— 与 `style` 字段无关，故单列；
   * 仅作用于 `connector` 元素，其它类型跳过。只改内存场景，自动保存负责落盘。
   */
  function applyConnectorPatch(patch: {
    startArrow?: ArrowHead;
    endArrow?: ArrowHead;
    routing?: ConnectorRouting;
  }): void {
    const cur = sceneRef.current;
    const sel = selectedIdsRef.current;
    if (sel.size === 0) return;
    const ts = new Date().toISOString();
    const next: BoardScene = {
      ...cur,
      elements: cur.elements.map((e): Element =>
        sel.has(e.id) && e.type === 'connector'
          ? ({ ...e, ...patch, updatedBy: actorId, updatedAt: ts } as Element)
          : e,
      ),
    };
    replaceScene(next, 'canvas');
  }

  /**
   * 切换选区的锁定态 —— 选区全锁定则解锁、否则全锁定。锁定元素不可拖拽 /
   * 缩放 / 旋转 / 删除 / 编辑，也不被框选纳入（仅可点选以便解锁）。
   */
  function toggleLock(): void {
    const cur = sceneRef.current;
    const sel = selectedIdsRef.current;
    if (sel.size === 0) return;
    const selEls = cur.elements.filter((e) => sel.has(e.id));
    const lock = !selEls.every((e) => e.locked); // 非全锁定 → 锁定
    const ts = new Date().toISOString();
    const next: BoardScene = {
      ...cur,
      elements: cur.elements.map((e): Element =>
        sel.has(e.id)
          ? ({ ...e, locked: lock, updatedBy: actorId, updatedAt: ts } as Element)
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

  /**
   * 多选整组拖拽结束 —— 全体成员按相同偏移整体平移，落点处的可归属元素
   * （文件 / 文本 / 图形 / 手绘）重设所属区域，成为该区域下的元素。
   *
   *  - 随被拖区域一起移动的子元素保持归属不变（它们跟区域整体平移）。
   *  - 文件改变归属须经 server 移动磁盘上的真实文件（其余元素仅改内存场景）。
   *  - 落定后 growRegions 让区域增长以包住落入的内容。
   */
  function finishGroupDrag(d: DragState): void {
    const cur = sceneRef.current;
    const ts = new Date().toISOString();
    // 本次一起移动的区域 —— 其子元素随区域整体平移，不重新判定归属。
    const movedRegionIds = new Set<string>();
    for (const id of d.memberIds) {
      const el = cur.elements.find((x) => x.id === id);
      if (el?.type === 'region') movedRegionIds.add(id);
    }
    // 1. 全体成员按偏移平移。
    const moved = cur.elements.map((e): Element =>
      d.memberIds.has(e.id)
        ? ({
            ...e,
            x: e.x + d.offsetX,
            y: e.y + d.offsetY,
            autoPlaced: false,
            updatedBy: actorId,
            updatedAt: ts,
          } as Element)
        : e,
    );
    // 2. 落点处重设归属 —— 文件 / 文本 / 图形 / 手绘按落点所在区域设 parentId。
    const regions = regionsOf(moved);
    const fileMoves: { el: FileElement; target: RegionElement | null }[] = [];
    const reparented = moved.map((e): Element => {
      if (!d.memberIds.has(e.id)) return e;
      if (
        e.type !== 'file' &&
        e.type !== 'text' &&
        e.type !== 'shape' &&
        e.type !== 'draw'
      ) {
        return e;
      }
      // 随被拖区域一起移动的子元素 —— 保持原归属。
      if (e.parentId && movedRegionIds.has(e.parentId)) return e;
      const target = regionForCard(
        { x: e.x, y: e.y, width: e.width, height: e.height },
        regions,
      );
      if (e.type === 'file') {
        const curRegion = regionForFile(e.path, regions);
        if ((target?.id ?? null) !== (curRegion?.id ?? null)) {
          fileMoves.push({ el: e, target });
        }
      }
      return { ...e, parentId: target ? target.id : null } as Element;
    });
    // 3. 区域增长以包住落入的内容。
    const grown = growRegions(reparented);
    replaceScene({ ...cur, elements: grown.elements }, 'canvas');
    // 4. 文件改变归属 —— 经 server 移动磁盘上的真实文件（SSE 刷回权威场景）。
    if (fileMoves.length > 0) {
      if (connection !== 'connected') {
        window.alert('未连接 board-server，文件元素的归属未在磁盘上同步。');
        return;
      }
      for (const { el, target } of fileMoves) {
        const baseName = fileBaseName(el.path);
        const to = target ? `${target.path}/${baseName}` : baseName;
        void moveFile(el.path, to, el.x, el.y).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          window.alert(`移动文件「${baseName}」失败：${msg}`);
        });
      }
    }
  }

  /** 拖拽结束分发。 */
  function finishDrag(d: DragState): void {
    if (d.kind === 'group') finishGroupDrag(d);
    else if (d.kind === 'region') finishRegionDrag(d);
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
    selectOnly(el.id);
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
    selectOnly(el.id);
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
   * 图形标签就地编辑提交 —— 写回 `shape.label`；文本去空后为空则置 label
   * 为 null（无标签），否则保留原 label 的其它字段（如 fontSize）。
   */
  function commitShapeLabel(id: string, text: string): void {
    const cur = sceneRef.current;
    const ts = new Date().toISOString();
    const next: BoardScene = {
      ...cur,
      elements: cur.elements.map((e): Element => {
        if (e.id !== id || e.type !== 'shape') return e;
        const label = text.trim() ? { ...(e.label ?? {}), text } : null;
        return { ...e, label, updatedBy: actorId, updatedAt: ts } as Element;
      }),
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
    kind: 'file' | 'region' | 'text' | 'element' | 'group',
    explicitMembers?: ReadonlySet<string>,
  ): void {
    if (e.button !== 0) return; // 仅响应主键
    e.currentTarget.setPointerCapture(e.pointerId);
    const cur = sceneRef.current;
    // 随本次拖拽一起平移的元素集 —— group 为整个选区（或调用方显式给定的
    // 成员集，用于点中未选元素即拖整组），其余仅自身；其中若含区域则连带
    // 其子元素（保持「区域包含其内容」一起移动）。
    const members = new Set<string>(
      kind === 'group'
        ? (explicitMembers ?? selectedIdsRef.current)
        : [el.id],
    );
    for (const id of [...members]) {
      const m = cur.elements.find((x) => x.id === id);
      if (m?.type === 'region') {
        for (const c of cur.elements) {
          if (c.parentId === id) members.add(c.id);
        }
      }
    }
    // 锁定元素不随拖拽移动 —— 从成员集剔除（被拖元素本身锁定时调用方已拦截）。
    for (const id of [...members]) {
      if (cur.elements.find((x) => x.id === id)?.locked) members.delete(id);
    }
    setDrag({
      kind,
      elementId: el.id,
      memberIds: members,
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

  /**
   * 计算本次拖拽的对齐吸附 —— 把被拖元素并集包围盒的边 / 中线吸附到画布上
   * 其它元素的对应线。连线本身包围盒不可靠，不参与（既不吸附也不作参照）。
   */
  function snapForDrag(
    d: DragState,
    rawDx: number,
    rawDy: number,
  ): { dx: number; dy: number; guides: SnapGuide[] } {
    const cur = sceneRef.current;
    // 被拖元素的并集包围盒（场景原坐标）。
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const e of cur.elements) {
      if (!d.memberIds.has(e.id) || e.type === 'connector') continue;
      x0 = Math.min(x0, e.x);
      y0 = Math.min(y0, e.y);
      x1 = Math.max(x1, e.x + e.width);
      y1 = Math.max(y1, e.y + e.height);
    }
    if (!Number.isFinite(x0)) return { dx: rawDx, dy: rawDy, guides: [] };
    const dragged: RectLike = {
      x: x0 + rawDx,
      y: y0 + rawDy,
      width: x1 - x0,
      height: y1 - y0,
    };
    // 参照矩形 —— 非被拖、非连线 / 建议的元素。
    const refs: RectLike[] = [];
    for (const e of cur.elements) {
      if (d.memberIds.has(e.id)) continue;
      if (e.type === 'connector' || e.type === 'suggestion') continue;
      refs.push({ x: e.x, y: e.y, width: e.width, height: e.height });
    }
    return computeSnap(dragged, rawDx, rawDy, refs, SNAP_THRESHOLD_PX / zoom);
  }

  /**
   * 指针移动 —— 把屏幕位移换算为画布偏移（除以 zoom），应用对齐吸附后更新
   * 拖拽状态。按住 Ctrl/⌘ 临时关闭吸附。
   */
  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>): void {
    const d = drag;
    if (!d || d.pointerId !== e.pointerId) return;
    const dxScreen = e.clientX - d.startScreenX;
    const dyScreen = e.clientY - d.startScreenY;
    const moved = d.moved || Math.hypot(dxScreen, dyScreen) > DRAG_THRESHOLD_PX;
    let dx = dxScreen / zoom;
    let dy = dyScreen / zoom;
    let guides: SnapGuide[] = [];
    if (moved && !e.ctrlKey && !e.metaKey) {
      const snap = snapForDrag(d, dx, dy);
      dx = snap.dx;
      dy = snap.dy;
      guides = snap.guides;
    }
    setDrag({ ...d, offsetX: dx, offsetY: dy, moved });
    setSnapGuides(guides);
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
    setSnapGuides([]);
    if (d.moved) finishDrag(d);
    else if (d.kind === 'group') {
      // 多选中对某元素的单击（未拖拽）—— 选区收敛到该元素（属编组则收敛到组）。
      selectGroupOf(d.elementId);
    }
  }

  /** 指针取消（如系统手势打断）—— 直接丢弃拖拽，不改场景。 */
  function handlePointerCancel(e: React.PointerEvent<HTMLDivElement>): void {
    setDrag((d) => (d && d.pointerId === e.pointerId ? null : d));
    setSnapGuides([]);
  }

  /**
   * 指针按下连线本体 —— 发起整条连线（或其所在多选组）的拖拽。
   *
   * 连线是 SVG，不走卡槽的指针捕获，改用 window 监听（与端点重连一致）。
   * 复用整组拖拽（kind='group'）：单拖连线即 memberIds 仅含其自身。
   */
  function beginConnectorDrag(
    connId: string,
    e: React.PointerEvent<SVGElement>,
  ): void {
    if (e.button !== 0) return;
    const cur = sceneRef.current;
    const gset = groupMembersOf(connId);
    const keepSel =
      selectedIdsRef.current.has(connId) && selectedIdsRef.current.size > 1;
    if (!keepSel) setSelectedIds(gset);
    // 拖拽成员：点中已选元素则用当前选区，否则用连线所属编组（无组即自身）；
    // 含区域则连带其子元素。
    const members = new Set<string>(
      keepSel ? selectedIdsRef.current : gset,
    );
    for (const id of [...members]) {
      const m = cur.elements.find((x) => x.id === id);
      if (m?.type === 'region') {
        for (const c of cur.elements) {
          if (c.parentId === id) members.add(c.id);
        }
      }
    }
    const d: DragState = {
      kind: 'group',
      elementId: connId,
      memberIds: members,
      pointerId: e.pointerId,
      startScreenX: e.clientX,
      startScreenY: e.clientY,
      startX: 0,
      startY: 0,
      offsetX: 0,
      offsetY: 0,
      moved: false,
    };
    connDragRef.current = d;
    setDrag(d);
    window.addEventListener('pointermove', onConnDragMove);
    window.addEventListener('pointerup', onConnDragUp);
    window.addEventListener('pointercancel', onConnDragUp);
  }

  /** 连线本体拖拽移动 —— window 监听，把屏幕位移换算为画布偏移。 */
  function onConnDragMove(e: PointerEvent): void {
    const d = connDragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const z = viewportRef.current.zoom;
    const dxs = e.clientX - d.startScreenX;
    const dys = e.clientY - d.startScreenY;
    const next: DragState = {
      ...d,
      offsetX: dxs / z,
      offsetY: dys / z,
      moved: d.moved || Math.hypot(dxs, dys) > DRAG_THRESHOLD_PX,
    };
    connDragRef.current = next;
    setDrag(next);
  }

  /** 连线本体拖拽结束 —— 越过阈值则按整组拖拽落定，否则按点选处理。 */
  function onConnDragUp(e: PointerEvent): void {
    const d = connDragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    window.removeEventListener('pointermove', onConnDragMove);
    window.removeEventListener('pointerup', onConnDragUp);
    window.removeEventListener('pointercancel', onConnDragUp);
    connDragRef.current = null;
    setDrag(null);
    if (e.type === 'pointercancel') return; // 取消 —— 丢弃，不改场景
    if (d.moved) finishDrag(d);
    else if (selectedIdsRef.current.size > 1) {
      // 多选中对连线的单击（未拖拽）—— 选区收敛到该连线（属编组则收敛到组）。
      selectGroupOf(d.elementId);
    }
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

  /** 指针按下旋转手柄 —— 记录元素中心，进入旋转。 */
  function beginRotate(
    e: React.PointerEvent<HTMLDivElement>,
    el: CanvasElement,
  ): void {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setRotate({
      elementId: el.id,
      pointerId: e.pointerId,
      cx: el.x + el.width / 2,
      cy: el.y + el.height / 2,
      angle: el.angle || 0,
    });
  }

  /**
   * 旋转手柄移动 —— 角度 = 元素中心指向指针的方向（手柄正上方为 0）。
   * 按住 Shift 吸附到 15° 整数倍。
   */
  function handleRotateMove(e: React.PointerEvent<HTMLDivElement>): void {
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    setRotate((r) => {
      if (!r || r.pointerId !== e.pointerId) return r;
      const px = (e.clientX - rect.left) / zoom - scrollX;
      const py = (e.clientY - rect.top) / zoom - scrollY;
      let a = Math.atan2(py - r.cy, px - r.cx) + Math.PI / 2;
      if (e.shiftKey) {
        const step = Math.PI / 12; // 15°
        a = Math.round(a / step) * step;
      }
      return { ...r, angle: a };
    });
  }

  /** 旋转结束 —— 角度有变化则提交。 */
  function handleRotateUp(e: React.PointerEvent<HTMLDivElement>): void {
    const r = rotate;
    if (!r || r.pointerId !== e.pointerId) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // 已释放，忽略。
    }
    setRotate(null);
    const cur = sceneRef.current;
    const el = cur.elements.find((x) => x.id === r.elementId);
    if (el && (el.angle || 0) !== r.angle) {
      replaceScene(patchElement(cur, r.elementId, { angle: r.angle }), 'canvas');
    }
  }

  /** 旋转取消 —— 丢弃，不改场景。 */
  function handleRotateCancel(e: React.PointerEvent<HTMLDivElement>): void {
    setRotate((r) => (r && r.pointerId === e.pointerId ? null : r));
  }

  /**
   * 调整选区的图层顺序（z 序）—— 置顶 / 置底 / 上移一层 / 下移一层。
   *
   * 把全部元素按 z 排好后，按 mode 重排选区元素的位置，再给全体重新赋
   * 连续 z（`index` → base36 定宽串）；只有顺序真变了才落场景。
   * 上移 / 下移时选区内部相对次序保持不变（成块移动，不互相穿越）。
   */
  function reorderSelection(
    mode: 'front' | 'back' | 'forward' | 'backward',
  ): void {
    const cur = sceneRef.current;
    const sel = selectedIdsRef.current;
    if (sel.size === 0) return;
    const ordered = [...cur.elements].sort((a, b) =>
      a.z < b.z ? -1 : a.z > b.z ? 1 : 0,
    );
    let next: Element[];
    if (mode === 'front') {
      next = [
        ...ordered.filter((e) => !sel.has(e.id)),
        ...ordered.filter((e) => sel.has(e.id)),
      ];
    } else if (mode === 'back') {
      next = [
        ...ordered.filter((e) => sel.has(e.id)),
        ...ordered.filter((e) => !sel.has(e.id)),
      ];
    } else if (mode === 'forward') {
      next = [...ordered];
      for (let i = next.length - 2; i >= 0; i -= 1) {
        if (sel.has(next[i]!.id) && !sel.has(next[i + 1]!.id)) {
          [next[i], next[i + 1]] = [next[i + 1]!, next[i]!];
        }
      }
    } else {
      next = [...ordered];
      for (let i = 1; i < next.length; i += 1) {
        if (sel.has(next[i]!.id) && !sel.has(next[i - 1]!.id)) {
          [next[i], next[i - 1]] = [next[i - 1]!, next[i]!];
        }
      }
    }
    // 顺序没变就不动（避免无意义的撤销项）。
    let changed = false;
    for (let i = 0; i < ordered.length; i += 1) {
      if (ordered[i]!.id !== next[i]!.id) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    const newZ = new Map<string, string>();
    next.forEach((e, i) => newZ.set(e.id, i.toString(36).padStart(8, '0')));
    const ts = new Date().toISOString();
    const elements = cur.elements.map((e): Element => {
      const z = newZ.get(e.id);
      return z !== undefined && z !== e.z
        ? ({ ...e, z, updatedBy: actorId, updatedAt: ts } as Element)
        : e;
    });
    replaceScene({ ...cur, elements }, 'canvas');
  }

  /** 对齐 / 分布作用的元素 —— 连线几何派生、锁定元素冻结，均排除。 */
  function alignTargets(): Element[] {
    const sel = selectedIdsRef.current;
    return sceneRef.current.elements.filter(
      (e) => sel.has(e.id) && e.type !== 'connector' && !e.locked,
    );
  }

  /**
   * 把选区元素按某条边 / 中线对齐 —— 基准为选区并集包围盒。连线 / 锁定
   * 元素不参与。
   */
  function alignSelection(
    mode: 'left' | 'center-h' | 'right' | 'top' | 'center-v' | 'bottom',
  ): void {
    const els = alignTargets();
    if (els.length < 2) return;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const e of els) {
      x0 = Math.min(x0, e.x);
      y0 = Math.min(y0, e.y);
      x1 = Math.max(x1, e.x + e.width);
      y1 = Math.max(y1, e.y + e.height);
    }
    const ids = new Set(els.map((e) => e.id));
    const ts = new Date().toISOString();
    const cur = sceneRef.current;
    const elements = cur.elements.map((e): Element => {
      if (!ids.has(e.id)) return e;
      let { x, y } = e;
      if (mode === 'left') x = x0;
      else if (mode === 'right') x = x1 - e.width;
      else if (mode === 'center-h') x = (x0 + x1) / 2 - e.width / 2;
      else if (mode === 'top') y = y0;
      else if (mode === 'bottom') y = y1 - e.height;
      else if (mode === 'center-v') y = (y0 + y1) / 2 - e.height / 2;
      return {
        ...e,
        x,
        y,
        autoPlaced: false,
        updatedBy: actorId,
        updatedAt: ts,
      } as Element;
    });
    replaceScene({ ...cur, elements }, 'canvas');
  }

  /**
   * 把选区元素沿某轴等距分布 —— 首尾元素不动，其余使相邻包围盒间隙相等。
   * 需 ≥3 个可对齐元素。
   */
  function distributeSelection(axis: 'h' | 'v'): void {
    const els = alignTargets();
    if (els.length < 3) return;
    const horiz = axis === 'h';
    const sizeOf = (e: Element): number => (horiz ? e.width : e.height);
    const posOf = (e: Element): number => (horiz ? e.x : e.y);
    const sorted = [...els].sort((a, b) => posOf(a) - posOf(b));
    const spanStart = posOf(sorted[0]!);
    const last = sorted[sorted.length - 1]!;
    const spanEnd = posOf(last) + sizeOf(last);
    const sumSize = sorted.reduce((s, e) => s + sizeOf(e), 0);
    const gap = (spanEnd - spanStart - sumSize) / (sorted.length - 1);
    const newPos = new Map<string, number>();
    let cursor = spanStart;
    for (const e of sorted) {
      newPos.set(e.id, cursor);
      cursor += sizeOf(e) + gap;
    }
    const ts = new Date().toISOString();
    const cur = sceneRef.current;
    const elements = cur.elements.map((e): Element => {
      const p = newPos.get(e.id);
      if (p === undefined) return e;
      return {
        ...e,
        ...(horiz ? { x: p } : { y: p }),
        autoPlaced: false,
        updatedBy: actorId,
        updatedAt: ts,
      } as Element;
    });
    replaceScene({ ...cur, elements }, 'canvas');
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

  // 恰好选中一个元素时的单选 id —— 样式面板 / 缩放手柄 / 连线端点手柄
  // 只在单选时出现（多选只显示选择框，可整组拖拽 / 批量删除）。
  const soloId: string | null =
    selectedIds.size === 1 ? ([...selectedIds][0] ?? null) : null;

  // 选中连线时 —— 其两端实际绑定的元素（「实际连接的位置」），给它们也套上
  // 对应形状的外包围，直观显示这条连线连了谁。
  const selectedConnector =
    soloId != null
      ? scene.elements.find(
          (e): e is ConnectorElement =>
            e.id === soloId && e.type === 'connector',
        )
      : undefined;
  const connBoundEls: Element[] = selectedConnector
    ? [selectedConnector.start.elementId, selectedConnector.end.elementId]
        .filter((id): id is string => !!id)
        .map((id) => scene.elements.find((e) => e.id === id))
        .filter((e): e is Element => !!e)
    : [];

  // 当前选区的元素对象列表 —— 选区面板（样式 / 编组）与右键菜单共用。
  const selectedEls: Element[] = scene.elements.filter((e) =>
    selectedIds.has(e.id),
  );
  // 选区能否编组（≥2）/ 取消编组（含已编组元素）。
  const selCanGroup = selectedEls.length >= 2;
  const selCanUngroup = selectedEls.some(
    (e) => (e.groupIds?.length ?? 0) > 0,
  );
  // 可对齐 / 分布的元素数 —— 排除连线（几何派生）与锁定元素。
  const selAlignCount = selectedEls.filter(
    (e) => e.type !== 'connector' && !e.locked,
  ).length;
  // 选区面板各节按元素类型条件显示：粗糙度（图形 / 手绘）、边角（矩形）、
  // 文字（文本 / 带标签图形）、箭头（连线）。
  const selHasRough = selectedEls.some(
    (e) => e.type === 'shape' || e.type === 'draw',
  );
  const selHasRect = selectedEls.some(
    (e) => e.type === 'shape' && e.shape === 'rectangle',
  );
  const selHasText = selectedEls.some(
    (e) => e.type === 'text' || (e.type === 'shape' && !!e.label?.text),
  );
  // 选区代表连线 —— 「箭头」节取其起点 / 终点箭头为指示值。
  const selConnector = selectedEls.find(
    (e): e is ConnectorElement => e.type === 'connector',
  );
  const selArrows = selConnector
    ? {
        startArrow: selConnector.startArrow,
        endArrow: selConnector.endArrow,
        routing: selConnector.routing,
      }
    : null;

  // 右键菜单（落在元素上时）的选区操作对象 —— 菜单的编组 / 取消编组 / 删除
  // 都作用于当前选区，与单选时的菜单一致。区域 / 文件夹背后是真实文件夹，
  // 不在画布删除范围（与 board rm / Delete 键一致），故 menuDeletable 排除之。
  const menuSel: Element[] = menu && menu.onElement ? selectedEls : [];
  const menuCanGroup = menuSel.length >= 2;
  const menuCanUngroup = menuSel.some((e) => (e.groupIds?.length ?? 0) > 0);
  const menuDeletable = menuSel.filter(
    (e) => e.type !== 'region' && e.type !== 'folder' && !e.locked,
  );
  // 菜单锁定项：选区全锁定显示「解锁」，否则「锁定」。
  const menuAllLocked =
    menuSel.length > 0 && menuSel.every((e) => e.locked);

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

          // 拖拽偏移：本次拖拽的全部成员（单拖为自身，区域拖含子元素，
          // 整组拖为整个选区）都实时套上偏移变换，一起跟随指针。
          let dx = 0;
          let dy = 0;
          if (drag?.moved && drag.memberIds.has(el.id)) {
            dx = drag.offsetX;
            dy = drag.offsetY;
          }
          const offset = dx !== 0 || dy !== 0;

          // 缩放：被缩放区域自身实时变矩形（位置 + 尺寸都可能变）。
          const resizing = resize?.elementId === el.id;
          const rx = resizing && resize ? resize.x : el.x;
          const ry = resizing && resize ? resize.y : el.y;
          const rw = resizing && resize ? resize.w : el.width;
          const rh = resizing && resize ? resize.h : el.height;

          // 旋转：区域不旋转（容器、轴对齐）；其余按 el.angle，旋转中实时取
          // rotate.angle。卡槽绕中心旋转（CSS transform 默认 transform-origin）。
          const rotating = rotate?.elementId === el.id;
          const ang =
            el.type === 'region'
              ? 0
              : rotating && rotate
                ? rotate.angle
                : el.angle || 0;

          const regionActive =
            el.type === 'region' &&
            ((drag?.kind === 'region' && drag.elementId === el.id) || resizing);

          const slotStyle: React.CSSProperties = {
            left: `${rx}px`,
            top: `${ry}px`,
            width: `${rw}px`,
            height: `${rh}px`,
          };
          // 卡槽变换：先平移（拖拽偏移）再绕中心旋转。
          const tParts: string[] = [];
          if (offset) tParts.push(`translate(${dx}px, ${dy}px)`);
          if (ang) tParts.push(`rotate(${ang}rad)`);
          if (tParts.length > 0) {
            slotStyle.transform = tParts.join(' ');
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
                if (e.button !== 0) return;
                if (e.shiftKey) {
                  // shift 点选 —— 切换区域（连同其编组）在选区中的去留。
                  toggleInSelection(region.id);
                  return;
                }
                const gset = groupMembersOf(region.id);
                const keepSel =
                  selectedIds.has(region.id) && selectedIds.size > 1;
                if (!keepSel) setSelectedIds(gset);
                const groupDrag = keepSel || gset.size > 1;
                beginDrag(
                  e,
                  region,
                  groupDrag ? 'group' : 'region',
                  !keepSel && groupDrag ? gset : undefined,
                );
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
            onRotateStart: (e) => beginRotate(e, el),
            onRotateMove: handleRotateMove,
            onRotateUp: handleRotateUp,
            onRotateCancel: handleRotateCancel,
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
                      if (el.locked) {
                        // 锁定元素 —— 仅可点选（以便解锁），不拖拽。
                        if (e.shiftKey) toggleInSelection(el.id);
                        else setSelectedIds(new Set([el.id]));
                        return;
                      }
                      if (e.shiftKey) {
                        // shift 点选 —— 切换该元素（连同其编组）在选区中的去留。
                        toggleInSelection(el.id);
                        return;
                      }
                      // 点中的元素属编组则选中整组；点中已选元素则保持选区直接拖。
                      const gset = groupMembersOf(el.id);
                      const keepSel =
                        selectedIds.has(el.id) && selectedIds.size > 1;
                      if (!keepSel) setSelectedIds(gset);
                      const groupDrag = keepSel || gset.size > 1;
                      if (groupDrag) {
                        beginDrag(
                          e,
                          el,
                          'group',
                          keepSel ? undefined : gset,
                        );
                      } else if (isFile || isText) {
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
              // 双击图形 —— 进入标签就地编辑（双击经指针捕获落在卡槽上）。
              // 锁定元素不可编辑。
              onDoubleClick={
                isShape && !el.locked
                  ? () => setEditingLabelId(el.id)
                  : undefined
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
                <ShapeView
                  element={
                    resizing && resize
                      ? { ...el, width: resize.w, height: resize.h }
                      : el
                  }
                  editingLabel={editingLabelId === el.id}
                  onLabelCommit={(t) => {
                    commitShapeLabel(el.id, t);
                    setEditingLabelId((cur) =>
                      cur === el.id ? null : cur,
                    );
                  }}
                  onLabelCancel={() =>
                    setEditingLabelId((cur) => (cur === el.id ? null : cur))
                  }
                />
              ) : el.type === 'draw' ? (
                <DrawView
                  element={resizing && resize ? liveDrawEl(el, resize) : el}
                />
              ) : (
                <FileCard element={el} missing={missingFileIds.has(el.id)} />
              )}
              {/* 选中态：选择框 —— 选中（含多选）即出现。 */}
              {selectedIds.has(el.id) ? (
                <SelectionFrame element={el} width={rw} height={rh} />
              ) : null}
              {/* 八向缩放手柄（圆点）—— 仅单选时出现（多选不缩放）；
                  锁定元素不出手柄。 */}
              {soloId === el.id && !el.locked ? (
                <ResizeHandles
                  api={resizeApi}
                  rotatable={el.type !== 'region'}
                />
              ) : null}
              {/* 锁定角标 —— 标示该元素已锁定。 */}
              {el.locked ? (
                <div className="ov-lock-badge" aria-hidden="true">
                  🔒
                </div>
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
          selectedIds={selectedIds}
          onSelect={(id, additive) =>
            additive ? toggleInSelection(id) : selectGroupOf(id)
          }
          onBodyDown={beginConnectorDrag}
          interactive={!connectMode}
          zoom={zoom}
          onEndpointCommit={rebindConnectorEndpoint}
          onEndpointHover={handleEndpointHover}
          onLabelEdit={(id) => setEditingLabelId(id)}
          editingLabelId={editingLabelId}
          onLabelCommit={(id, text) => {
            commitConnectorLabel(id, text);
            setEditingLabelId((cur) => (cur === id ? null : cur));
          }}
          onLabelCancel={() => setEditingLabelId(null)}
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

        {/* 选中连线时 —— 其两端实际连接的元素套上对应形状的外包围。 */}
        {connBoundEls.map((e) => (
          <ConnectTargetRing key={`cb-${e.id}`} element={e} />
        ))}

        {/* 连线 / 端点拖拽：给悬停的元素套一圈贴合其形状的外包围高亮。 */}
        {hoverConnEl ? <ConnectTargetRing element={hoverConnEl} /> : null}

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

        {/* 左键框选多选的虚线框 */}
        {selectMarquee ? (
          <div
            className="ov-marquee"
            style={{
              left: `${selectMarquee.x}px`,
              top: `${selectMarquee.y}px`,
              width: `${selectMarquee.width}px`,
              height: `${selectMarquee.height}px`,
            }}
          />
        ) : null}

        {/* 拖拽对齐参考线 —— 被拖元素的边 / 中线对齐到其它元素时浮现。
            画布坐标 div 细线，厚度按 1/zoom 折算成恒定 1 屏幕像素。 */}
        {snapGuides.map((g, i) => {
          const t = 1 / zoom; // 1 屏幕像素对应的画布尺寸
          const gStyle: React.CSSProperties =
            g.axis === 'x'
              ? {
                  left: `${g.pos - t / 2}px`,
                  top: `${g.from}px`,
                  width: `${t}px`,
                  height: `${g.to - g.from}px`,
                }
              : {
                  left: `${g.from}px`,
                  top: `${g.pos - t / 2}px`,
                  width: `${g.to - g.from}px`,
                  height: `${t}px`,
                };
          return (
            <div
              key={`snap-${i}`}
              className="ov-snap-guide"
              style={gStyle}
              aria-hidden="true"
            />
          );
        })}

        {/* 选中编组的整体外框 —— 套在逐元素选择框之外，标示「这是一个组」 */}
        {groupBoxes.map((b) => (
          <div
            key={`gb-${b.gid}`}
            className="ov-group-box"
            style={{
              left: `${b.x - 8}px`,
              top: `${b.y - 8}px`,
              width: `${b.width + 16}px`,
              height: `${b.height + 16}px`,
            }}
          />
        ))}

        {/* 创建预览 —— 拖拽创建图形 / 手绘 / 连线时的实时呈现 */}
        {creating ? (
          <CreationPreview state={creating} actorId={actorId} />
        ) : null}
      </div>

      {/* 选区面板 —— 左键选中任意元素 / 多选 / 编组后浮在画布右上角：调样式
          + 编组 / 取消编组。多选时样式改动应用到整个选区。屏幕定位。 */}
      {selectedEls.length > 0 ? (
        <StylePanel
          style={selectedEls[0]!.style}
          count={selectedEls.length}
          hasFill={selectedEls.some((e) => e.type !== 'connector')}
          hasRough={selHasRough}
          hasRect={selHasRect}
          hasText={selHasText}
          arrows={selArrows}
          onChange={applyStyleToSelection}
          onArrowChange={applyConnectorPatch}
          canGroup={selCanGroup}
          canUngroup={selCanUngroup}
          onGroup={groupSelection}
          onUngroup={ungroupSelection}
          onLayer={reorderSelection}
          locked={selectedEls.every((e) => e.locked)}
          onToggleLock={toggleLock}
          alignCount={selAlignCount}
          onAlign={alignSelection}
          onDistribute={distributeSelection}
        />
      ) : null}

      {/* 右键上下文菜单 —— 落在元素上时对当前选区可做「编组 / 取消编组 /
          删除」（单选、多选同款菜单）；末尾恒有「整理」（作用域由位置决定）。 */}
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
              top: `${Math.min(menu.y, window.innerHeight - 156)}px`,
            }}
          >
            {menu.onElement && menuCanGroup ? (
              <button
                type="button"
                className="ov-menu__item"
                onClick={() => {
                  groupSelection();
                  closeMenu();
                }}
              >
                <span className="ov-menu__icon" aria-hidden="true">
                  ⊞
                </span>
                编组（{menuSel.length} 项）
              </button>
            ) : null}
            {menu.onElement && menuCanUngroup ? (
              <button
                type="button"
                className="ov-menu__item"
                onClick={() => {
                  ungroupSelection();
                  closeMenu();
                }}
              >
                <span className="ov-menu__icon" aria-hidden="true">
                  ⊟
                </span>
                取消编组
              </button>
            ) : null}
            {menu.onElement && menuSel.length > 0 ? (
              <button
                type="button"
                className="ov-menu__item"
                onClick={() => {
                  toggleLock();
                  closeMenu();
                }}
              >
                <span className="ov-menu__icon" aria-hidden="true">
                  {menuAllLocked ? '🔓' : '🔒'}
                </span>
                {menuAllLocked ? '解锁' : '锁定'}
              </button>
            ) : null}
            {menu.onElement && menuDeletable.length > 0 ? (
              <button
                type="button"
                className="ov-menu__item ov-menu__item--danger"
                onClick={() => {
                  void deleteSelectedSet(selectedIds);
                  closeMenu();
                }}
              >
                <span className="ov-menu__icon" aria-hidden="true">
                  🗑
                </span>
                {menuDeletable.length === 1
                  ? delMenuLabel(menuDeletable[0]!)
                  : `删除选中 ${menuDeletable.length} 项`}
              </button>
            ) : null}
            {menu.onElement && menuSel.length > 0 ? (
              <div className="ov-menu__divider" aria-hidden="true" />
            ) : null}
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
