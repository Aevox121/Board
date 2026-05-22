/**
 * 自研画布层 —— 画布工具栏。
 *
 * Board 自有的工具栏，浮在画布顶部居中。选中创建工具（矩形 / 椭圆 / 菱形 /
 * 箭头 / 画笔 / 文本）后在画布上拖拽即创建对应元素；选择 / 橡皮擦为操作工具。
 *
 * 工具 id 沿用 Excalidraw 的工具类型命名（rectangle / freedraw 等）—— 仅是
 * 历史命名约定。
 */
import './canvas.css';

/** 工具 id —— 与 Excalidraw 工具类型同名。 */
export type ToolId =
  | 'selection'
  | 'rectangle'
  | 'ellipse'
  | 'diamond'
  | 'region'
  | 'arrow'
  | 'freedraw'
  | 'text'
  | 'image'
  | 'embed'
  | 'eraser';

/** 把图标 path 包进统一规格的 SVG。filled=true 用填充（如光标），否则描边。 */
function icon(path: JSX.Element, filled = false): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {path}
    </svg>
  );
}

interface ToolDef {
  id: ToolId;
  label: string;
  /** 字母快捷键（大写，仅用于展示；实际匹配不分大小写）。 */
  shortcut: string;
  icon: JSX.Element;
}

/** 工具表 —— `'divider'` 占位符渲染为分隔线。 */
const TOOLS: Array<ToolDef | 'divider'> = [
  {
    id: 'selection',
    label: '选择',
    shortcut: 'V',
    icon: icon(
      <path d="M5 3v15.6l4.3-4.1 2.7 5.9 2.4-1.1-2.6-5.7h6z" />,
      true,
    ),
  },
  'divider',
  {
    id: 'rectangle',
    label: '矩形',
    shortcut: 'R',
    icon: icon(<rect x="3.5" y="6" width="17" height="12" rx="1.5" />),
  },
  {
    id: 'ellipse',
    label: '椭圆',
    shortcut: 'O',
    icon: icon(<ellipse cx="12" cy="12" rx="9" ry="6.5" />),
  },
  {
    id: 'diamond',
    label: '菱形',
    shortcut: 'D',
    icon: icon(<path d="M12 3l9 9-9 9-9-9z" />),
  },
  {
    id: 'region',
    label: '区域',
    shortcut: 'G',
    icon: icon(
      <rect x="3.5" y="5.5" width="17" height="13" rx="1.5"
        strokeDasharray="3 2.4" />,
    ),
  },
  {
    id: 'arrow',
    label: '箭头 / 连线',
    shortcut: 'A',
    icon: icon(<path d="M3 12h16M13 6l7 6-7 6" />),
  },
  {
    id: 'freedraw',
    label: '画笔',
    shortcut: 'P',
    icon: icon(
      <>
        <path d="M4 20l3.5-1L19 7.5 16.5 5 5 16.5z" />
        <path d="M14.5 7l2.5 2.5" />
      </>,
    ),
  },
  {
    id: 'text',
    label: '文本',
    shortcut: 'T',
    icon: icon(<path d="M5 6.5V5h14v1.5M12 5v14M9 19h6" />),
  },
  {
    id: 'image',
    label: '图片',
    shortcut: 'I',
    icon: icon(
      <>
        <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
        <circle cx="9" cy="10" r="1.7" />
        <path d="M20 15.5l-5-5-8 8" />
      </>,
    ),
  },
  {
    id: 'embed',
    label: '嵌入链接',
    shortcut: 'U',
    icon: icon(
      <>
        <path d="M10.5 13.5a3.4 3.4 0 0 0 5 .3l2.7-2.7a3.4 3.4 0 0 0-4.8-4.8l-1.5 1.5" />
        <path d="M13.5 10.5a3.4 3.4 0 0 0-5-.3L5.8 12.9a3.4 3.4 0 0 0 4.8 4.8l1.5-1.5" />
      </>,
    ),
  },
  'divider',
  {
    id: 'eraser',
    label: '橡皮擦',
    shortcut: 'E',
    icon: icon(
      <>
        <path d="M9 20h11" />
        <path d="M13 5l6 6-7.5 7.5H8L4.5 15z" />
        <path d="M10 8l6 6" />
      </>,
    ),
  },
];

/**
 * 工具快捷键映射 —— 字母键（小写）+ 按工具栏顺序的数字键（1..8）→ 工具 id。
 * 由 CanvasShell 的全局 keydown 监听消费。
 */
export const TOOL_SHORTCUTS: Readonly<Record<string, ToolId>> = (() => {
  const map: Record<string, ToolId> = {};
  let n = 0;
  for (const t of TOOLS) {
    if (t === 'divider') continue;
    n += 1;
    map[t.shortcut.toLowerCase()] = t.id;
    map[String(n)] = t.id;
  }
  return map;
})();

export interface ToolbarProps {
  /** 当前工具 id。 */
  activeTool: string;
  /** 选中某工具的回调。 */
  onSelect: (tool: ToolId) => void;
}

/** 画布工具栏。 */
export function Toolbar({ activeTool, onSelect }: ToolbarProps): JSX.Element {
  return (
    <div className="cv-toolbar" role="toolbar" aria-label="画布工具">
      {TOOLS.map((t, i) =>
        t === 'divider' ? (
          <div key={`d${i}`} className="cv-tool-divider" aria-hidden="true" />
        ) : (
          <button
            key={t.id}
            type="button"
            className={'cv-tool' + (t.id === activeTool ? ' cv-tool--active' : '')}
            title={`${t.label} — ${t.shortcut}`}
            aria-label={t.label}
            aria-pressed={t.id === activeTool}
            onClick={() => onSelect(t.id)}
          >
            {t.icon}
            <span className="cv-tool__key" aria-hidden="true">
              {t.shortcut}
            </span>
          </button>
        ),
      )}
    </div>
  );
}
