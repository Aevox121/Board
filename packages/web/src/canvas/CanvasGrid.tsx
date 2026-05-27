/**
 * 自研画布层 —— 无限网格背景（增量2：画布外壳）。
 *
 * 一张随视口平移 / 缩放的点阵，铺在画布最底层（覆盖层之下）。点阵用 CSS
 * radial-gradient 平铺实现 —— `background-size` 跟 zoom、`background-position`
 * 跟 scroll，浏览器自动取模平铺，无需逐点渲染，平移缩放零成本。
 *
 * 视口订阅：用 useViewport 直接读外部 viewportStore —— 走 React 路径但本组件
 * 本身极轻量（只刷一个 div 的 style），是可接受的代价。
 */
import { useViewport } from './viewportStore';
import './canvas.css';

/** 网格基准间距（画布单位）。 */
const GRID = 40;

/** 无限点阵网格背景。 */
export function CanvasGrid(): JSX.Element {
  const { scrollX, scrollY, zoom } = useViewport();
  // 屏幕上的网格间距。
  const cell = GRID * zoom;
  // 缩得过小时点阵过密 —— 间距小于阈值就线性淡出，避免糊成一片。
  const opacity = cell < 14 ? Math.max(0, (cell - 6) / 8) : 1;

  return (
    <div
      className="cv-grid"
      aria-hidden="true"
      style={{
        backgroundSize: `${cell}px ${cell}px`,
        // 画布原点 (0,0) 的屏幕位置 = scroll * zoom；平铺自动取模。
        backgroundPosition: `${scrollX * zoom}px ${scrollY * zoom}px`,
        opacity,
      }}
    />
  );
}
