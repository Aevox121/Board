/**
 * 工厂函数 — 创建白板与元素，按规格填充默认值。
 * 见 specs/数据模型规格.md §2/§3/§6。
 */
import {
  SCHEMA_VERSION,
  type BoardMeta,
  type BoardScene,
  type BoardSettings,
  type Participant,
  type Element,
  type ElementId,
  type BaseElement,
  type ElementType,
  type ElementState,
  type TextElement,
  type RegionElement,
  type FileElement,
  type FolderElement,
  type ShapeElement,
  type ShapeKind,
  type DrawElement,
  type ConnectorElement,
  type Endpoint,
  type ArrowHead,
  type ConnectorRouting,
  type FileDisplayMode,
  type SuggestionElement,
  type SuggestionType,
  type SuggestionStatus,
  type ImageElement,
  type EmbedElement,
  type ParticipantId,
} from './types.js';
import { newBoardId, newElementId, newShareToken } from './ids.js';
import { makeDefaultStyle } from './style.js';

const nowISO = (): string => new Date().toISOString();

/** 白板默认设置 */
export const DEFAULT_SETTINGS: BoardSettings = {
  previewSizeLimitMB: 20,
  autoSnapshotOnRiskyOp: true,
  gridEnabled: false,
  defaultRegionAutoFile: true,
};

export interface CreateBoardOptions {
  name: string;
  participants?: Participant[];
  settings?: Partial<BoardSettings>;
}

/** 创建一份新白板的 meta.json 对象。 */
export function createBoardMeta(opts: CreateBoardOptions): BoardMeta {
  const ts = nowISO();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: newBoardId(),
    name: opts.name,
    createdAt: ts,
    updatedAt: ts,
    participants: opts.participants ?? [],
    settings: { ...DEFAULT_SETTINGS, ...opts.settings },
    snapshots: [],
    // 默认生成 token；不需要鉴权的部署（本地 dev）忽略它即可。
    shareToken: newShareToken(),
  };
}

/** 创建一份空场景 board.json 对象。 */
export function createBoardScene(): BoardScene {
  return {
    schemaVersion: SCHEMA_VERSION,
    viewport: { x: 0, y: 0, zoom: 1 },
    elements: [],
  };
}

/**
 * 计算高于现有所有元素的 z 值。
 * M1 简化方案：定宽 base36 递增字符串（字典序即层级序）。
 * M4 协同阶段替换为真正的分数索引。
 */
export function nextZ(elements: ReadonlyArray<Pick<Element, 'z'>>): string {
  let max = -1;
  for (const e of elements) {
    const v = parseInt(e.z, 36);
    if (!Number.isNaN(v) && v > max) max = v;
  }
  return (max + 1).toString(36).padStart(8, '0');
}

/** 元素工厂的通用入参。 */
export interface BaseElementInit {
  x: number;
  y: number;
  width: number;
  height: number;
  createdBy: ParticipantId;
  z?: string;
  parentId?: string | null;
  autoPlaced?: boolean;
  state?: ElementState;
}

function baseElement(type: ElementType, init: BaseElementInit): BaseElement {
  const ts = nowISO();
  return {
    id: newElementId(),
    type,
    x: init.x,
    y: init.y,
    width: init.width,
    height: init.height,
    angle: 0,
    z: init.z ?? '00000000',
    parentId: init.parentId ?? null,
    locked: false,
    state: init.state ?? 'committed',
    autoPlaced: init.autoPlaced ?? false,
    style: makeDefaultStyle(),
    createdBy: init.createdBy,
    updatedBy: init.createdBy,
    createdAt: ts,
    updatedAt: ts,
  };
}

/** 创建文本 / Markdown 卡片元素。 */
export function createTextElement(
  init: BaseElementInit & { markdown?: string },
): TextElement {
  return {
    ...baseElement('text', init),
    type: 'text',
    markdown: init.markdown ?? '',
    autoWidth: true,
    editMode: 'preview',
  };
}

/** 创建区域元素。 */
export function createRegionElement(
  init: BaseElementInit & {
    path: string;
    label: string;
    description?: string;
    /** 软归属人；不传默认归属于 createdBy（PRD §8.3）。 */
    ownerId?: ParticipantId | null;
  },
): RegionElement {
  return {
    ...baseElement('region', init),
    type: 'region',
    path: init.path,
    label: init.label,
    description: init.description ?? '',
    autoFile: true,
    assignedAgentId: null,
    ownerId: init.ownerId === undefined ? init.createdBy : init.ownerId,
    collapsed: false,
  };
}

/** 创建文件元素。 */
export function createFileElement(
  init: BaseElementInit & {
    path: string;
    mime: string;
    size: number;
    displayMode?: FileDisplayMode;
  },
): FileElement {
  return {
    ...baseElement('file', init),
    type: 'file',
    path: init.path,
    mime: init.mime,
    size: init.size,
    displayMode: init.displayMode ?? 'card',
    previewable: true,
    version: 1,
  };
}

/** 创建文件夹元素。 */
export function createFolderElement(
  init: BaseElementInit & { path: string; expanded?: boolean },
): FolderElement {
  return {
    ...baseElement('folder', init),
    type: 'folder',
    path: init.path,
    expanded: init.expanded ?? false,
    viewMode: 'list',
  };
}

/** 创建几何图形元素。 */
export function createShapeElement(
  init: BaseElementInit & { shape: ShapeKind; label?: string },
): ShapeElement {
  return {
    ...baseElement('shape', init),
    type: 'shape',
    shape: init.shape,
    label: init.label ? { text: init.label } : null,
  };
}

/**
 * 创建手绘笔迹元素。
 * `points` 为相对元素原点 (x,y) 的采样点；`pressures` 为各点压感（0–1，可选）。
 */
export function createDrawElement(
  init: BaseElementInit & {
    points: Array<[number, number]>;
    pressures?: number[];
  },
): DrawElement {
  return {
    ...baseElement('draw', init),
    type: 'draw',
    points: init.points,
    pressures: init.pressures,
  };
}

/** 创建连线 / 箭头元素（连接两个元素，PRD §6.2）。 */
export function createConnectorElement(
  init: BaseElementInit & {
    start: Endpoint;
    end: Endpoint;
    startArrow?: ArrowHead;
    endArrow?: ArrowHead;
    routing?: ConnectorRouting;
    label?: string;
  },
): ConnectorElement {
  return {
    ...baseElement('connector', init),
    type: 'connector',
    start: init.start,
    end: init.end,
    startArrow: init.startArrow ?? 'none',
    endArrow: init.endArrow ?? 'arrow',
    routing: init.routing ?? 'straight',
    label: init.label ? { text: init.label } : null,
  };
}

/**
 * 创建画布原生图片元素（PRD §6.8）。
 * `assetId`（assets/ 内素材）与 `path`（files/ 内文件）二选一。
 */
export function createImageElement(
  init: BaseElementInit & {
    naturalWidth: number;
    naturalHeight: number;
    assetId?: string;
    path?: string;
  },
): ImageElement {
  return {
    ...baseElement('image', init),
    type: 'image',
    naturalWidth: init.naturalWidth,
    naturalHeight: init.naturalHeight,
    ...(init.assetId !== undefined ? { assetId: init.assetId } : {}),
    ...(init.path !== undefined ? { path: init.path } : {}),
  };
}

/** 创建外链嵌入元素（PRD §6.10）—— 默认链接卡。 */
export function createEmbedElement(
  init: BaseElementInit & { url: string; embedType?: 'iframe' | 'link-card' },
): EmbedElement {
  return {
    ...baseElement('embed', init),
    type: 'embed',
    url: init.url,
    embedType: init.embedType ?? 'link-card',
  };
}

/**
 * 创建建议元素（PRD §7.3）—— 不改原件，旁边承载 Agent 的提议。
 *
 * `payload` 是提议的元素对象（可并入白板的纯内容）；同意 `replace` 时其内容
 * 替换目标元素，同意 `add` 时它作为新元素加入场景。`reason` 是「建议理由」
 * 说明性文字 —— 只展示、同意时不并入。建议的处理逻辑见 suggestion.ts。
 */
export function createSuggestionElement(
  init: BaseElementInit & {
    targetId: ElementId;
    suggestionType: SuggestionType;
    payload: Element;
    authorId: ParticipantId;
    reason?: string;
    status?: SuggestionStatus;
  },
): SuggestionElement {
  return {
    ...baseElement('suggestion', init),
    type: 'suggestion',
    targetId: init.targetId,
    suggestionType: init.suggestionType,
    payload: init.payload,
    reason: init.reason ?? '',
    status: init.status ?? 'pending',
    authorId: init.authorId,
    thread: [],
  };
}
