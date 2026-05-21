/**
 * 自研画布层 —— 画布工具栏（增量2：画布外壳）。
 *
 * Board 自有的工具栏，浮在画布左缘。增量2 它驱动 Excalidraw 的当前工具
 * （Board 选工具 → 经 BoardCanvas 调 setActiveTool），Excalidraw 自身工具栏
 * 由 CSS 隐藏。增量4 起绘制 / 选择改由 Board 自有逻辑接管，工具栏不动。
 *
 * 工具 id 直接采用 Excalidraw 的工具类型字符串，省去映射层。
 */
import './canvas.css';

/** 工具 id —— 与 Excalidraw 工具类型同名。 */
export type ToolId =
  | 'selection'
  | 'rectangle'
  | 'ellipse'
  | 'diamond'
  | 'arrow'
  | 'freedraw'
  | 'text'
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
  icon: JSX.Element;
}

/** 工具表 —— `'divider'` 占位符渲染为分隔线。 */
const TOOLS: Array<ToolDef | 'divider'> = [
  {
    id: 'selection',
    label: '选择',
    icon: icon(
      <path d="M5 3v15.6l4.3-4.1 2.7 5.9 2.4-1.1-2.6-5.7h6z" />,
      true,
    ),
  },
  'divider',
  {
    id: 'rectangle',
    label: '矩形',
    icon: icon(<rect x="3.5" y="6" width="17" height="12" rx="1.5" />),
  },
  {
    id: 'ellipse',
    label: '椭圆',
    icon: icon(<ellipse cx="12" cy="12" rx="9" ry="6.5" />),
  },
  {
    id: 'diamond',
    label: '菱形',
    icon: icon(<path d="M12 3l9 9-9 9-9-9z" />),
  },
  {
    id: 'arrow',
    label: '箭头 / 连线',
    icon: icon(<path d="M3 12h16M13 6l7 6-7 6" />),
  },
  {
    id: 'freedraw',
    label: '画笔',
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
    icon: icon(<path d="M5 6.5V5h14v1.5M12 5v14M9 19h6" />),
  },
  'divider',
  {
    id: 'eraser',
    label: '橡皮擦',
    icon: icon(
      <>
        <path d="M9 20h11" />
        <path d="M13 5l6 6-7.5 7.5H8L4.5 15z" />
        <path d="M10 8l6 6" />
      </>,
    ),
  },
];

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
            title={t.label}
            aria-label={t.label}
            aria-pressed={t.id === activeTool}
            onClick={() => onSelect(t.id)}
          >
            {t.icon}
          </button>
        ),
      )}
    </div>
  );
}
