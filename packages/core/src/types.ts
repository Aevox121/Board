/**
 * Board 数据模型类型 — 对应 specs/数据模型规格.md。
 * 字段定义以规格文件为权威来源；本文件为其 TypeScript 落地。
 */

export type SchemaVersion = 1;
export const SCHEMA_VERSION: SchemaVersion = 1;

/** ISO 8601 UTC 时间串 */
export type ISO8601 = string;
/** 参与者 id：人类 `u_` 前缀 / Agent `a_` 前缀 */
export type ParticipantId = string;
/** 元素 id：`el_` + 12 位十六进制 */
export type ElementId = string;

// ──────────────────────────── meta.json ────────────────────────────

export interface BoardMeta {
  schemaVersion: SchemaVersion;
  /** `wb_` + 8 位十六进制，创建时生成、永不变 */
  id: string;
  name: string;
  createdAt: ISO8601;
  updatedAt: ISO8601;
  participants: Participant[];
  settings: BoardSettings;
  snapshots: SnapshotIndexEntry[];
}

export interface BoardSettings {
  /** 超过此值（MB）的文件只显示索引卡片（PRD §6.4） */
  previewSizeLimitMB: number;
  /** 高风险操作前自动建快照（PRD §8.5） */
  autoSnapshotOnRiskyOp: boolean;
  gridEnabled: boolean;
  defaultRegionAutoFile: boolean;
}

// ─────────────────────────── board.json ────────────────────────────

export interface BoardScene {
  schemaVersion: SchemaVersion;
  viewport: Viewport;
  elements: Element[];
}

export interface Viewport {
  x: number;
  y: number;
  /** 缩放，范围 0.1–5.0 */
  zoom: number;
}

// ─────────────────────────── Participant ───────────────────────────

export interface Participant {
  id: ParticipantId;
  type: 'human' | 'agent';
  name: string;
  /** hex 颜色，用于光标 / 在场色 */
  color: string;
  /** 仅 Agent：归属的人类 id */
  ownerId: ParticipantId | null;
  avatar: string | null;
}

// ───────────────────────────── Style ───────────────────────────────

export type FillStyle = 'solid' | 'hachure' | 'cross-hatch' | 'none';
export type StrokeStyle = 'solid' | 'dashed' | 'dotted';
export type FontFamily = 'hand' | 'normal' | 'code';

/** 统一样式对象（PRD §6.7）——作用于白板上所有元素，各类型用其适用子集。 */
export interface Style {
  strokeColor: string;
  /** hex 或 `'transparent'` */
  backgroundColor: string;
  fillStyle: FillStyle;
  /** 1–8 */
  strokeWidth: number;
  strokeStyle: StrokeStyle;
  /** 0–2，手绘粗糙度 */
  roughness: number;
  /** 0–100 */
  opacity: number;
  cornerRadius: number;
  fontFamily: FontFamily;
  fontSize: number;
}

// ─────────────────────── Element envelope ──────────────────────────

export type ElementType =
  | 'draw'
  | 'shape'
  | 'connector'
  | 'text'
  | 'file'
  | 'folder'
  | 'region'
  | 'image'
  | 'suggestion'
  | 'embed';

/** `committed` 正式 / `draft` Agent 进行中（PRD §7.4） */
export type ElementState = 'committed' | 'draft';

/** 元素评论（PRD §8.4）—— 挂在任意元素上的一条批注。 */
export interface ElementComment {
  /** 评论者参与者 id */
  by: ParticipantId;
  text: string;
  ts: ISO8601;
}

/** 所有元素共享的通用字段。 */
export interface BaseElement {
  id: ElementId;
  type: ElementType;
  /** 画布坐标，元素左上角；无限平面，可为负 */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 旋转弧度（radians），与 Excalidraw 一致 */
  angle: number;
  /** 层级——分数索引字符串，协同下无冲突插入 */
  z: string;
  /** 所属区域/文件夹元素 id；null = 直接在画布上 */
  parentId: ElementId | null;
  locked: boolean;
  hidden?: boolean;
  state: ElementState;
  /** true = 坐标由自动排版给出；false = 用户/Agent 显式定位 */
  autoPlaced: boolean;
  style: Style;
  createdBy: ParticipantId;
  updatedBy: ParticipantId;
  createdAt: ISO8601;
  updatedAt: ISO8601;
  /** 元素上的评论（PRD §8.4）；无评论时省略 */
  comments?: ElementComment[];
  /** 扩展位，未知字段保留不丢弃 */
  meta?: Record<string, unknown>;
}

// ─────────────────────── 各元素类型 ────────────────────────

/** 手绘笔迹 */
export interface DrawElement extends BaseElement {
  type: 'draw';
  /** 笔迹点 `[dx,dy]`，相对元素左上角 */
  points: Array<[number, number]>;
  /** 各点压感 0–1 */
  pressures?: number[];
}

export type ShapeKind = 'rectangle' | 'ellipse' | 'diamond';

/** 几何图形 */
export interface ShapeElement extends BaseElement {
  type: 'shape';
  shape: ShapeKind;
  label: { text: string; fontSize?: number } | null;
}

export type ArrowHead = 'none' | 'arrow' | 'triangle' | 'dot';
export type ConnectorRouting = 'straight' | 'orthogonal' | 'curved';
export type AnchorSide = 'auto' | 'top' | 'right' | 'bottom' | 'left';

export interface Endpoint {
  /** 非空 = 绑定到元素（随之移动）；null = 用 point 作自由端点 */
  elementId: ElementId | null;
  anchor: AnchorSide;
  point?: [number, number];
}

/** 连线 / 箭头 */
export interface ConnectorElement extends BaseElement {
  type: 'connector';
  start: Endpoint;
  end: Endpoint;
  startArrow: ArrowHead;
  endArrow: ArrowHead;
  routing: ConnectorRouting;
  waypoints?: Array<[number, number]>;
  label: { text: string } | null;
}

/** 文本 / Markdown 卡片 */
export interface TextElement extends BaseElement {
  type: 'text';
  markdown: string;
  /** true = 宽度随内容自适应 */
  autoWidth: boolean;
  /** 当前显示态（PRD §6.3：可切换） */
  editMode: 'source' | 'preview';
}

export type FileDisplayMode = 'icon' | 'card' | 'preview';

/** 文件元素 */
export interface FileElement extends BaseElement {
  type: 'file';
  /** 相对 files/ 的路径 */
  path: string;
  mime: string;
  /** 字节数 */
  size: number;
  displayMode: FileDisplayMode;
  /** 派生：size 超过 previewSizeLimitMB 时为 false（PRD §6.4） */
  previewable: boolean;
  /** 文件版本号，被替换时 +1 */
  version: number;
}

/** 文件夹元素 */
export interface FolderElement extends BaseElement {
  type: 'folder';
  path: string;
  expanded: boolean;
  viewMode: 'list' | 'grid' | 'tree';
}

/** 区域——本质是一个文件夹（PRD §5.5） */
export interface RegionElement extends BaseElement {
  type: 'region';
  /** 对应 files/ 下的文件夹路径 */
  path: string;
  label: string;
  /** 区域用途描述；同步落地为该文件夹 README.md */
  description: string;
  /** true = 拖入边界的文件自动归档进该文件夹 */
  autoFile: boolean;
  /** 被指派的 Agent（PRD §7.6） */
  assignedAgentId: ParticipantId | null;
  /** 软归属人（PRD §8.3，不强制锁定） */
  ownerId: ParticipantId | null;
  collapsed: boolean;
}

/** 画布原生图片 */
export interface ImageElement extends BaseElement {
  type: 'image';
  /** 指向 assets/ 内文件（粘贴/拖入的画布素材） */
  assetId?: string;
  /** 二选一：图片来自 files/ 时用 path */
  path?: string;
  naturalWidth: number;
  naturalHeight: number;
}

export type SuggestionType = 'replace' | 'add';
export type SuggestionStatus = 'pending' | 'accepted' | 'rejected';

/** 建议的「描述」反馈回路对话条目 */
export interface ThreadMsg {
  by: ParticipantId;
  role: 'human' | 'agent';
  text: string;
  ts: ISO8601;
}

/** 建议元素（PRD §7.3）——不改原件，旁边给建议 */
export interface SuggestionElement extends BaseElement {
  type: 'suggestion';
  /** 被建议的元素 id */
  targetId: ElementId;
  suggestionType: SuggestionType;
  /**
   * 提议的元素对象（可为任意类型）——「会被替换/新增进白板的纯内容」。
   * 同意建议时**只有 payload** 并入目标；不含「为什么这么建议」的说明。
   */
  payload: Element;
  /**
   * 建议理由 —— 表明「这是一条建议」的说明性文字（为什么改 / 改了什么）。
   * 只在建议卡上展示，**同意时不会并入目标元素**，与可并入的 payload 严格分开。
   */
  reason: string;
  status: SuggestionStatus;
  /** 发起建议的 Agent id */
  authorId: ParticipantId;
  thread: ThreadMsg[];
}

/** 外链嵌入（后续阶段） */
export interface EmbedElement extends BaseElement {
  type: 'embed';
  url: string;
  embedType: 'iframe' | 'link-card';
}

/** 元素可辨识联合（discriminated union by `type`） */
export type Element =
  | DrawElement
  | ShapeElement
  | ConnectorElement
  | TextElement
  | FileElement
  | FolderElement
  | RegionElement
  | ImageElement
  | SuggestionElement
  | EmbedElement;

// ─────────────────────── 快照与操作日志 ────────────────────────

export interface SnapshotIndexEntry {
  /** `snap_` + 4 位十六进制 */
  id: string;
  name: string;
  createdBy: ParticipantId;
  createdAt: ISO8601;
  /** true = 自动快照 */
  auto: boolean;
  /** 对应的 oplog seq */
  opSeq: number;
}

export type OpType =
  | 'element.create'
  | 'element.update'
  | 'element.move'
  | 'element.delete'
  | 'element.style'
  | 'file.add'
  | 'file.move'
  | 'file.delete'
  | 'region.create'
  | 'region.describe'
  | 'suggestion.create'
  | 'suggestion.accept'
  | 'suggestion.reject'
  | 'suggestion.comment'
  | 'snapshot.create'
  | 'snapshot.restore';

/** history/oplog.jsonl 的单行 */
export interface OpLogEntry {
  seq: number;
  op: OpType;
  actor: ParticipantId;
  ts: ISO8601;
  payload: Record<string, unknown>;
}
