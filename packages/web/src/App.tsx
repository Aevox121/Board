import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';

/**
 * M0 烟雾测试 — 验证 Excalidraw 能在本工程内挂载渲染。
 *
 * 后续里程碑在此基础上叠加：
 *  - M1：board.json 读写、文本/Markdown 卡片、统一样式
 *  - M2：DOM 覆盖层渲染文件/文件夹/区域元素（PRD §11 内容元素层）
 *  - M3：Agent 在场、Pencil 式过程可视化
 */
export default function App() {
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <Excalidraw />
    </div>
  );
}
