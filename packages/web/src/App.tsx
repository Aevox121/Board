/**
 * 应用根组件 —— Board Web「单人白板 + server 实时协同」。
 *
 * 结构：顶栏（应用外壳）+ 画布区（自研画布层 CanvasShell）。
 *
 * 启动流程（M4 增量3 起）：
 *  - 启动时探测 board-server（GET /api/health + GET /api/board）。
 *  - server 可达 → 载入其元数据（meta/files/tasks）；场景由 BoardProvider
 *    内部的 yjs-client 经 ws /yjs 自动同步进本地 Y.Doc。
 *  - server 不可达 → 「离线」模式，导入/导出兜底；yjs-client 后台指数退避
 *    重连，连上后场景自动收敛。
 *
 * 实时同步（M4 Yjs）：
 *  - 本地编辑 / 远端改动都经本地 Y.Doc 收敛；CRDT 自动合并，无需 ops diff。
 *  - SSE 仅保留 board-changed（refresh 元数据 = 文件列表 / tasks）+ presence
 *    通道；scene 改动不再走 SSE，避免冗余整板刷新。
 *  - 「保存」按钮在 Yjs 模式下是 no-op（变更自动同步），仍保留 UI 入口给习
 *    惯性用户。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { BoardProvider, useBoard } from './board/BoardContext';
import { TopBar, type SaveState } from './components/TopBar';
import { CanvasShell } from './canvas/CanvasShell';
import { FolderPanel } from './components/FolderPanel';
import { downloadBoardJSON, pickAndParseBoardJSON } from './board/boardFile';
import { exportBoardImage } from './board/exportImage';
import { BoardParseError } from '@board/core';
import { checkHealth, fetchBoard, ServerError } from './server/client';
import { subscribeBoardEvents } from './server/events';
import { presenceStore, type RemotePresence } from './presence/presenceStore';
import './App.css';

/** 外壳布局 —— 顶栏 + 画布区，纵向铺满视口。 */
function BoardApp(): JSX.Element {
  const {
    scene,
    meta,
    connection,
    renameBoard,
    replaceScene,
    loadFromServer,
  } = useBoard();

  // 「保存」按钮状态机 —— Yjs 模式下变更自动同步，按下时即时显示「已保存」。
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [probing, setProbing] = useState(true);
  const [folderViewOpen, setFolderViewOpen] = useState(false);
  const probedRef = useRef(false);
  const loadFromServerRef = useRef(loadFromServer);
  loadFromServerRef.current = loadFromServer;

  // ── 启动时探测 board-server 元数据（场景由 yjs-client 经 ws 自动同步）──
  useEffect(() => {
    if (probedRef.current) return;
    probedRef.current = true;
    void (async () => {
      try {
        await checkHealth();
        const data = await fetchBoard();
        loadFromServer(data.meta, data.files, data.tasks, 'initial');
      } catch (err) {
        if (err instanceof ServerError) {
          console.info('[board-web] 未连接到 board-server，进入离线模式：', err.message);
        } else {
          console.warn('[board-web] 连接 board-server 时发生意外错误：', err);
        }
      } finally {
        setProbing(false);
      }
    })();
  }, [loadFromServer]);

  // ── SSE 仅保留 presence 与元数据 refresh ─────────────────────────
  // 场景改动经 ws /yjs 自动同步，不再需要 SSE board-changed 触发整板拉取。
  // board-changed 仍用来刷新文件列表 + tasks（这些不在 Y.Doc 里）。
  useEffect(() => {
    if (connection !== 'connected') return;
    const refreshMeta = (): void => {
      void (async () => {
        try {
          const data = await fetchBoard();
          loadFromServerRef.current(data.meta, data.files, data.tasks, 'refresh');
        } catch (err) {
          console.info('[board-web] 元数据刷新失败，保留当前：', err);
        }
      })();
    };
    const unsubscribe = subscribeBoardEvents((frame) => {
      if (frame.type === 'board-changed') {
        refreshMeta();
      } else if (frame.type === 'presence' && frame.client) {
        presenceStore.applyUpdate(frame.client as RemotePresence);
      } else if (
        frame.type === 'presence-leave' &&
        typeof frame.clientId === 'string'
      ) {
        presenceStore.applyLeave(frame.clientId);
      }
    });
    return unsubscribe;
  }, [connection]);

  const handleExport = useCallback(() => {
    // 文件名取白板名，非法字符替换为 `-`。
    const safe = meta.name.replace(/[^\p{L}\p{N}_-]+/gu, '-') || 'board';
    downloadBoardJSON(scene, `${safe}.json`);
  }, [scene, meta.name]);

  const handleExportImage = useCallback(
    async (format: 'png' | 'svg') => {
      const safe = meta.name.replace(/[^\p{L}\p{N}_-]+/gu, '-') || 'board';
      try {
        await exportBoardImage(scene, format, safe);
      } catch (e) {
        window.alert(`导出失败：${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [scene, meta.name],
  );

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

  // ── 「保存」按钮 —— Yjs 模式下变更自动同步，按下即时显示「已保存」反馈 ─
  const handleSave = useCallback(() => {
    if (connection !== 'connected') return;
    setSaveState('saved');
    window.setTimeout(() => setSaveState('idle'), 1500);
  }, [connection]);

  return (
    <div className="app-shell">
      <TopBar
        boardName={meta.name}
        onRename={renameBoard}
        onImport={handleImport}
        onExport={handleExport}
        onExportImage={handleExportImage}
        onSave={handleSave}
        elementCount={scene.elements.length}
        connection={connection}
        probing={probing}
        saveState={saveState}
        folderViewOpen={folderViewOpen}
        onToggleFolderView={() => setFolderViewOpen((v) => !v)}
      />
      <div className="app-body">
        {folderViewOpen && <FolderPanel />}
        <CanvasShell />
      </div>
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
