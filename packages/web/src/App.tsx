/**
 * 应用根组件 —— Board Web M1「可运行的单人白板」。
 *
 * 结构：顶栏（应用外壳，干净暖色）+ 画布区（Excalidraw 铺满）。
 * 状态：BoardProvider 持有一份 @board/core 的 BoardScene 作为真相源。
 *
 * 后续里程碑在此基础上叠加：
 *  - M2：DOM 覆盖层渲染文件/文件夹/区域元素（PRD §11 内容元素层）
 *  - M3：Agent 在场、Pencil 式过程可视化
 */
import { useCallback } from 'react';
import { BoardProvider, useBoard } from './board/BoardContext';
import { TopBar } from './components/TopBar';
import { BoardCanvas } from './components/BoardCanvas';
import { downloadBoardJSON, pickAndParseBoardJSON } from './board/boardFile';
import { BoardParseError } from '@board/core';
import './App.css';

/** 外壳布局 —— 顶栏 + 画布区，纵向铺满视口。 */
function BoardApp(): JSX.Element {
  const { scene, meta, renameBoard, replaceScene } = useBoard();

  const handleExport = useCallback(() => {
    // 文件名取白板名，非法字符替换为 `-`。
    const safe = meta.name.replace(/[^\p{L}\p{N}_-]+/gu, '-') || 'board';
    downloadBoardJSON(scene, `${safe}.json`);
  }, [scene, meta.name]);

  const handleImport = useCallback(async () => {
    try {
      const imported = await pickAndParseBoardJSON();
      if (imported) {
        replaceScene(imported, 'import');
      }
    } catch (e) {
      const msg =
        e instanceof BoardParseError ? e.message : `导入失败：${String(e)}`;
      // M1 用原生 alert 反馈错误；后续里程碑替换为外壳风格的 toast。
      window.alert(msg);
    }
  }, [replaceScene]);

  return (
    <div className="app-shell">
      <TopBar
        boardName={meta.name}
        onRename={renameBoard}
        onImport={handleImport}
        onExport={handleExport}
        elementCount={scene.elements.length}
      />
      <BoardCanvas />
    </div>
  );
}

export default function App(): JSX.Element {
  return (
    <BoardProvider initialName="未命名白板">
      <BoardApp />
    </BoardProvider>
  );
}
