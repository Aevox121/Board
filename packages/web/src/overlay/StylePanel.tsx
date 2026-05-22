/**
 * 选区面板 —— 左键选中任意元素 / 多选 / 编组后浮出的统一面板。
 *
 * 内容：
 *  - 统一样式：描边色 / 背景色 / 描边宽度 / 描边样式 / 不透明度
 *    （即 `board style` CLI / MCP 所改的字段）。多选时改动应用到整个选区。
 *  - 编组操作：编组 / 取消编组（按选区状态条件显示）。
 *
 * 改动即 patch / 触发回调，由 OverlayLayer 写回内存场景并自动保存。
 */
import type { Style, StrokeStyle } from '@board/core';

/** 描边预设色 —— 经典手绘白板描边色板。 */
const STROKE_PRESETS = ['#1e1e1e', '#e03131', '#2f9e44', '#1971c2', '#f08c00'];
/** 背景预设色 —— 经典手绘白板背景色板（首项为透明）。 */
const BG_PRESETS = ['transparent', '#ffc9c9', '#b2f2bb', '#a5d8ff', '#ffec99'];
/** 描边宽度三档 —— 与原生面板的 细 / 粗 / 特粗 对应。 */
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

export interface StylePanelProps {
  /** 选区的代表样式 —— 多选时取首个元素的样式作为指示值。 */
  style: Style;
  /** 选区元素数。 */
  count: number;
  /** 选区是否含可填充元素（非连线）—— 决定是否显示「背景」一节。 */
  hasFill: boolean;
  /** 样式补丁回调 —— 由 OverlayLayer 应用到整个选区。 */
  onChange: (patch: Partial<Style>) => void;
  /** 选区 ≥2 时可编组。 */
  canGroup: boolean;
  /** 选区含已编组元素时可取消编组。 */
  canUngroup: boolean;
  /** 编组（Ctrl+G）。 */
  onGroup: () => void;
  /** 取消编组（Ctrl+Shift+G）。 */
  onUngroup: () => void;
  /** 水平翻转选区。 */
  onFlipH: () => void;
  /** 垂直翻转选区。 */
  onFlipV: () => void;
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

/** 选区面板（样式 + 编组）。 */
export function StylePanel({
  style: s,
  count,
  hasFill,
  onChange,
  canGroup,
  canUngroup,
  onGroup,
  onUngroup,
  onFlipH,
  onFlipV,
}: StylePanelProps): JSX.Element {
  const widthSel = nearestWidth(s.strokeWidth);

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

      <section className="ov-style-sec">
        <span className="ov-style-sec__label">描边宽度</span>
        <div className="ov-seg">
          {WIDTHS.map((w) => (
            <button
              key={w.value}
              type="button"
              className={
                'ov-seg__btn' +
                (widthSel === w.value ? ' ov-seg__btn--on' : '')
              }
              onClick={() => onChange({ strokeWidth: w.value })}
            >
              {w.label}
            </button>
          ))}
        </div>
      </section>

      <section className="ov-style-sec">
        <span className="ov-style-sec__label">描边样式</span>
        <div className="ov-seg">
          {STROKE_STYLES.map((ss) => (
            <button
              key={ss.value}
              type="button"
              className={
                'ov-seg__btn' +
                (s.strokeStyle === ss.value ? ' ov-seg__btn--on' : '')
              }
              onClick={() => onChange({ strokeStyle: ss.value })}
            >
              {ss.label}
            </button>
          ))}
        </div>
      </section>

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
        <span className="ov-style-sec__label">翻转</span>
        <div className="ov-seg">
          <button
            type="button"
            className="ov-seg__btn"
            onClick={onFlipH}
            title="水平翻转"
          >
            水平翻转
          </button>
          <button
            type="button"
            className="ov-seg__btn"
            onClick={onFlipV}
            title="垂直翻转"
          >
            垂直翻转
          </button>
        </div>
      </section>

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
    </div>
  );
}
