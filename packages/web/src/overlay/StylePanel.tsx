/**
 * 选区面板 —— 左键选中任意元素 / 多选 / 编组后浮出的统一面板。
 *
 * 内容：
 *  - 统一样式：描边色 / 背景色 / 填充纹理 / 描边宽度 / 边角 / 描边样式 /
 *    粗糙度 / 文字（字体 + 字号）/ 不透明度（即 `board style` CLI / MCP 所改
 *    的字段）。多选时改动应用到整个选区。
 *  - 连线专属：起点 / 终点箭头样式。
 *  - 图层顺序 / 编组操作（按选区状态条件显示）。
 *
 * 改动即 patch / 触发回调，由 OverlayLayer 写回内存场景并自动保存。
 */
import type {
  ArrowHead,
  ConnectorRouting,
  FillStyle,
  Style,
  StrokeStyle,
} from '@board/core';

/** 描边预设色 —— 经典手绘白板描边色板。 */
const STROKE_PRESETS = ['#1e1e1e', '#e03131', '#2f9e44', '#1971c2', '#f08c00'];
/** 背景预设色 —— 经典手绘白板背景色板（首项为透明）。 */
const BG_PRESETS = ['transparent', '#ffc9c9', '#b2f2bb', '#a5d8ff', '#ffec99'];
/** 描边宽度三档 —— 与原生面板的 细 / 中 / 粗 对应。 */
const WIDTHS: ReadonlyArray<{ label: string; value: number }> = [
  { label: '细', value: 1 },
  { label: '中', value: 2 },
  { label: '粗', value: 4 },
];
/** 描边样式三档。 */
const STROKE_STYLES: ReadonlyArray<{ label: string; value: StrokeStyle }> = [
  { label: '实线', value: 'solid' },
  { label: '虚线', value: 'dashed' },
  { label: '点线', value: 'dotted' },
];
/** 填充纹理三档（`none` 渲染同 `solid`，故归入「实心」）。 */
const FILL_STYLES: ReadonlyArray<{ label: string; value: FillStyle }> = [
  { label: '实心', value: 'solid' },
  { label: '斜线', value: 'hachure' },
  { label: '交叉', value: 'cross-hatch' },
];
/** 手绘粗糙度三档。 */
const ROUGHNESS: ReadonlyArray<{ label: string; value: number }> = [
  { label: '平整', value: 0 },
  { label: '适中', value: 1 },
  { label: '粗糙', value: 2 },
];
/** 字体三档。 */
const FONT_FAMILIES: ReadonlyArray<{
  label: string;
  value: Style['fontFamily'];
}> = [
  { label: '手写', value: 'hand' },
  { label: '正常', value: 'normal' },
  { label: '等宽', value: 'code' },
];
/** 字号三档。 */
const FONT_SIZES: ReadonlyArray<{ label: string; value: number }> = [
  { label: '小', value: 16 },
  { label: '中', value: 20 },
  { label: '大', value: 28 },
];
/** 端点箭头四档。 */
const ARROW_HEADS: ReadonlyArray<{ label: string; value: ArrowHead }> = [
  { label: '无', value: 'none' },
  { label: '箭头', value: 'arrow' },
  { label: '三角', value: 'triangle' },
  { label: '圆点', value: 'dot' },
];
/** 连线路由三档。 */
const ROUTINGS: ReadonlyArray<{ label: string; value: ConnectorRouting }> = [
  { label: '直线', value: 'straight' },
  { label: '折线', value: 'orthogonal' },
  { label: '曲线', value: 'curved' },
];
/** 选「圆角」时赋给 cornerRadius 的半径值（直角为 0）。 */
const ROUND_RADIUS = 16;

export interface StylePanelProps {
  /** 选区的代表样式 —— 多选时取首个元素的样式作为指示值。 */
  style: Style;
  /** 选区元素数。 */
  count: number;
  /** 选区是否含可填充元素（非连线）—— 决定是否显示「背景」一节。 */
  hasFill: boolean;
  /** 选区是否含图形 / 手绘 —— 决定是否显示「粗糙度」一节。 */
  hasRough: boolean;
  /** 选区是否含矩形图形 —— 决定是否显示「边角」一节。 */
  hasRect: boolean;
  /** 选区是否含文本 / 带标签图形 —— 决定是否显示「文字」一节。 */
  hasText: boolean;
  /** 选区代表连线的端点箭头 / 路由；无连线时为 null（不显示连线相关节）。 */
  arrows: {
    startArrow: ArrowHead;
    endArrow: ArrowHead;
    routing: ConnectorRouting;
  } | null;
  /** 样式补丁回调 —— 由 OverlayLayer 应用到整个选区。 */
  onChange: (patch: Partial<Style>) => void;
  /** 连线专属字段补丁（起点 / 终点箭头、路由）—— 仅作用于选区内的连线。 */
  onArrowChange: (patch: {
    startArrow?: ArrowHead;
    endArrow?: ArrowHead;
    routing?: ConnectorRouting;
  }) => void;
  /** 选区 ≥2 时可编组。 */
  canGroup: boolean;
  /** 选区含已编组元素时可取消编组。 */
  canUngroup: boolean;
  /** 编组（Ctrl+G）。 */
  onGroup: () => void;
  /** 取消编组（Ctrl+Shift+G）。 */
  onUngroup: () => void;
  /** 调整选区图层顺序（置顶 / 置底 / 上移 / 下移）。 */
  onLayer: (mode: 'front' | 'back' | 'forward' | 'backward') => void;
  /** 选区是否全部锁定 —— 为真时面板只显示「解锁」。 */
  locked: boolean;
  /** 切换选区锁定态。 */
  onToggleLock: () => void;
  /** 可对齐 / 分布的元素数 —— ≥2 显示「对齐」节、≥3 显示分布。 */
  alignCount: number;
  /** 对齐选区。 */
  onAlign: (
    mode: 'left' | 'center-h' | 'right' | 'top' | 'center-v' | 'bottom',
  ) => void;
  /** 沿某轴等距分布选区。 */
  onDistribute: (axis: 'h' | 'v') => void;
}

/** `<input type="color">` 需合法 #rrggbb；透明 / 异常值回退到白。 */
function normHex(c: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#ffffff';
}

/** 把任意描边宽度吸附到最接近的预设档（供分段按钮高亮）。 */
function nearestWidth(w: number): number {
  let best = WIDTHS[0]!.value;
  for (const x of WIDTHS) {
    if (Math.abs(x.value - w) < Math.abs(best - w)) best = x.value;
  }
  return best;
}

/** 把任意字号吸附到最接近的预设档（供分段按钮高亮）。 */
function nearestSize(s: number): number {
  let best = FONT_SIZES[0]!.value;
  for (const x of FONT_SIZES) {
    if (Math.abs(x.value - s) < Math.abs(best - s)) best = x.value;
  }
  return best;
}

/** 一行分段按钮 —— 选中项高亮。 */
function Seg<T extends string | number>({
  options,
  value,
  onPick,
}: {
  options: ReadonlyArray<{ label: string; value: T }>;
  value: T;
  onPick: (v: T) => void;
}): JSX.Element {
  return (
    <div className="ov-seg">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          className={'ov-seg__btn' + (value === o.value ? ' ov-seg__btn--on' : '')}
          onClick={() => onPick(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** 选区面板（样式 + 连线箭头 + 编组）。 */
export function StylePanel({
  style: s,
  count,
  hasFill,
  hasRough,
  hasRect,
  hasText,
  arrows,
  onChange,
  onArrowChange,
  canGroup,
  canUngroup,
  onGroup,
  onUngroup,
  onLayer,
  locked,
  onToggleLock,
  alignCount,
  onAlign,
  onDistribute,
}: StylePanelProps): JSX.Element {
  // 锁定态 —— 面板只给「解锁」入口，不暴露样式 / 变换控件。
  if (locked) {
    return (
      <div
        className="ov-style-panel"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="ov-style-panel__title">
          {count > 1 ? `已锁定 · ${count} 项` : '已锁定'}
        </div>
        <section className="ov-style-sec">
          <span className="ov-style-sec__label">锁定</span>
          <div className="ov-seg">
            <button
              type="button"
              className="ov-seg__btn"
              onClick={onToggleLock}
            >
              🔓 解锁
            </button>
          </div>
        </section>
      </div>
    );
  }
  const widthSel = nearestWidth(s.strokeWidth);
  // `none` 与 `solid` 渲染一致，归入「实心」高亮。
  const fillSel: FillStyle = s.fillStyle === 'none' ? 'solid' : s.fillStyle;
  const roughSel = Math.round(s.roughness);
  const sizeSel = nearestSize(s.fontSize);
  // 「填充」仅在选区有非透明背景时才有意义（透明背景下填充纹理不可见）。
  const showFill = hasFill && s.backgroundColor !== 'transparent';

  return (
    <div
      className="ov-style-panel"
      // 面板自身的指针操作不冒泡到画布 —— 避免被「点空白取消选中」误伤。
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="ov-style-panel__title">
        {count > 1 ? `选区 · ${count} 项` : '样式'}
      </div>

      <section className="ov-style-sec">
        <span className="ov-style-sec__label">描边</span>
        <div className="ov-swatches">
          {STROKE_PRESETS.map((c) => (
            <button
              key={c}
              type="button"
              className={
                'ov-swatch' + (s.strokeColor === c ? ' ov-swatch--on' : '')
              }
              style={{ background: c }}
              onClick={() => onChange({ strokeColor: c })}
              aria-label={`描边色 ${c}`}
            />
          ))}
          <label className="ov-swatch ov-swatch--custom" title="自定义描边色">
            <input
              type="color"
              value={normHex(s.strokeColor)}
              onChange={(e) => onChange({ strokeColor: e.target.value })}
            />
          </label>
        </div>
      </section>

      {hasFill ? (
        <section className="ov-style-sec">
          <span className="ov-style-sec__label">背景</span>
          <div className="ov-swatches">
            {BG_PRESETS.map((c) => (
              <button
                key={c}
                type="button"
                className={
                  'ov-swatch' +
                  (c === 'transparent' ? ' ov-swatch--none' : '') +
                  (s.backgroundColor === c ? ' ov-swatch--on' : '')
                }
                style={c === 'transparent' ? undefined : { background: c }}
                onClick={() => onChange({ backgroundColor: c })}
                aria-label={c === 'transparent' ? '透明背景' : `背景色 ${c}`}
              />
            ))}
            <label className="ov-swatch ov-swatch--custom" title="自定义背景色">
              <input
                type="color"
                value={normHex(s.backgroundColor)}
                onChange={(e) => onChange({ backgroundColor: e.target.value })}
              />
            </label>
          </div>
        </section>
      ) : null}

      {showFill ? (
        <section className="ov-style-sec">
          <span className="ov-style-sec__label">填充</span>
          <Seg
            options={FILL_STYLES}
            value={fillSel}
            onPick={(v) => onChange({ fillStyle: v })}
          />
        </section>
      ) : null}

      <section className="ov-style-sec">
        <span className="ov-style-sec__label">描边宽度</span>
        <Seg
          options={WIDTHS}
          value={widthSel}
          onPick={(v) => onChange({ strokeWidth: v })}
        />
      </section>

      {hasRect ? (
        <section className="ov-style-sec">
          <span className="ov-style-sec__label">边角</span>
          <Seg
            options={[
              { label: '直角', value: 0 },
              { label: '圆角', value: 1 },
            ]}
            value={s.cornerRadius > 0 ? 1 : 0}
            onPick={(v) =>
              onChange({ cornerRadius: v === 1 ? ROUND_RADIUS : 0 })
            }
          />
        </section>
      ) : null}

      <section className="ov-style-sec">
        <span className="ov-style-sec__label">描边样式</span>
        <Seg
          options={STROKE_STYLES}
          value={s.strokeStyle}
          onPick={(v) => onChange({ strokeStyle: v })}
        />
      </section>

      {hasRough ? (
        <section className="ov-style-sec">
          <span className="ov-style-sec__label">粗糙度</span>
          <Seg
            options={ROUGHNESS}
            value={roughSel}
            onPick={(v) => onChange({ roughness: v })}
          />
        </section>
      ) : null}

      {hasText ? (
        <section className="ov-style-sec">
          <span className="ov-style-sec__label">字体</span>
          <Seg
            options={FONT_FAMILIES}
            value={s.fontFamily}
            onPick={(v) => onChange({ fontFamily: v })}
          />
          <Seg
            options={FONT_SIZES}
            value={sizeSel}
            onPick={(v) => onChange({ fontSize: v })}
          />
        </section>
      ) : null}

      {arrows ? (
        <section className="ov-style-sec">
          <span className="ov-style-sec__label">线型</span>
          <Seg
            options={ROUTINGS}
            value={arrows.routing}
            onPick={(v) => onArrowChange({ routing: v })}
          />
        </section>
      ) : null}

      {arrows ? (
        <section className="ov-style-sec">
          <span className="ov-style-sec__label">起点箭头</span>
          <Seg
            options={ARROW_HEADS}
            value={arrows.startArrow}
            onPick={(v) => onArrowChange({ startArrow: v })}
          />
        </section>
      ) : null}

      {arrows ? (
        <section className="ov-style-sec">
          <span className="ov-style-sec__label">终点箭头</span>
          <Seg
            options={ARROW_HEADS}
            value={arrows.endArrow}
            onPick={(v) => onArrowChange({ endArrow: v })}
          />
        </section>
      ) : null}

      <section className="ov-style-sec">
        <span className="ov-style-sec__label">不透明度</span>
        <div className="ov-style-opacity">
          <input
            type="range"
            min={0}
            max={100}
            step={10}
            value={s.opacity}
            onChange={(e) => onChange({ opacity: Number(e.target.value) })}
            aria-label="不透明度"
          />
          <span className="ov-style-opacity__val">{s.opacity}</span>
        </div>
      </section>

      <section className="ov-style-sec">
        <span className="ov-style-sec__label">图层顺序</span>
        <div className="ov-seg">
          <button
            type="button"
            className="ov-seg__btn"
            onClick={() => onLayer('front')}
            title="置顶（Ctrl+Shift+]）"
          >
            置顶
          </button>
          <button
            type="button"
            className="ov-seg__btn"
            onClick={() => onLayer('forward')}
            title="上移一层（Ctrl+]）"
          >
            上移
          </button>
          <button
            type="button"
            className="ov-seg__btn"
            onClick={() => onLayer('backward')}
            title="下移一层（Ctrl+[）"
          >
            下移
          </button>
          <button
            type="button"
            className="ov-seg__btn"
            onClick={() => onLayer('back')}
            title="置底（Ctrl+Shift+[）"
          >
            置底
          </button>
        </div>
      </section>

      {alignCount >= 2 ? (
        <section className="ov-style-sec">
          <span className="ov-style-sec__label">对齐</span>
          <div className="ov-seg">
            <button
              type="button"
              className="ov-seg__btn"
              onClick={() => onAlign('left')}
              title="左对齐"
            >
              左
            </button>
            <button
              type="button"
              className="ov-seg__btn"
              onClick={() => onAlign('center-h')}
              title="水平居中对齐"
            >
              居中
            </button>
            <button
              type="button"
              className="ov-seg__btn"
              onClick={() => onAlign('right')}
              title="右对齐"
            >
              右
            </button>
          </div>
          <div className="ov-seg">
            <button
              type="button"
              className="ov-seg__btn"
              onClick={() => onAlign('top')}
              title="顶对齐"
            >
              上
            </button>
            <button
              type="button"
              className="ov-seg__btn"
              onClick={() => onAlign('center-v')}
              title="垂直居中对齐"
            >
              居中
            </button>
            <button
              type="button"
              className="ov-seg__btn"
              onClick={() => onAlign('bottom')}
              title="底对齐"
            >
              下
            </button>
          </div>
          {alignCount >= 3 ? (
            <div className="ov-seg">
              <button
                type="button"
                className="ov-seg__btn"
                onClick={() => onDistribute('h')}
                title="水平等距分布"
              >
                水平分布
              </button>
              <button
                type="button"
                className="ov-seg__btn"
                onClick={() => onDistribute('v')}
                title="垂直等距分布"
              >
                垂直分布
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      {canGroup || canUngroup ? (
        <section className="ov-style-sec">
          <span className="ov-style-sec__label">编组</span>
          <div className="ov-seg">
            {canGroup ? (
              <button
                type="button"
                className="ov-seg__btn"
                onClick={onGroup}
                title="编组（Ctrl+G）"
              >
                编组
              </button>
            ) : null}
            {canUngroup ? (
              <button
                type="button"
                className="ov-seg__btn"
                onClick={onUngroup}
                title="取消编组（Ctrl+Shift+G）"
              >
                取消编组
              </button>
            ) : null}
          </div>
        </section>
      ) : null}

      <section className="ov-style-sec">
        <span className="ov-style-sec__label">锁定</span>
        <div className="ov-seg">
          <button
            type="button"
            className="ov-seg__btn"
            onClick={onToggleLock}
            title="锁定选区 —— 锁定后不可拖拽 / 缩放 / 删除 / 编辑"
          >
            🔒 锁定
          </button>
        </div>
      </section>
    </div>
  );
}
