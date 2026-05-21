/**
 * 应用根组件 —— Board Web「可运行的单人白板 + server 对接」。
 *
 * 结构：顶栏（应用外壳，干净暖色）+ 画布区（Excalidraw + DOM 覆盖层）。
 * 状态：BoardProvider 持有一份 @board/core 的 BoardScene 作为真相源。
 *
 * 启动流程（web ⇄ server 对接）：
 *  - 启动时探测 board-server（GET /api/health + GET /api/board）。
 *  - server 可达 → 载入其持有的真实 .board，进入「已连接」模式，「保存」可用。
 *  - server 不可达 → 「离线」模式，保留空白板 + 导入/导出兜底。
 *
 * M2 实时刷新：
 *  - 进入「已连接」模式后，用 EventSource 订阅 server 的 `/api/events` SSE。
 *  - 收到 `{"type":"board-changed"}` → 重新 fetchBoard() 刷新场景（含覆盖层）。
 *  - server 不可达 / 端点未实现时 SSE 静默失败，不影响离线模式。
 *
 * 后续里程碑在此基础上叠加：
 *  - M3：Agent 在场、Pencil 式过程可视化
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { BoardProvider, useBoard } from './board/BoardContext';
import { TopBar, type SaveState } from './components/TopBar';
import { BoardCanvas } from './components/BoardCanvas';
import { FolderPanel } from './components/FolderPanel';
import { downloadBoardJSON, pickAndParseBoardJSON } from './board/boardFile';
import { BoardParseError } from '@board/core';
import { checkHealth, fetchBoard, putScene, ServerError } from './server/client';
import { subscribeBoardEvents } from './server/events';
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
    importTick,
  } = useBoard();

  // 「保存」按钮状态机：idle → saving → saved/error。
  const [saveState, setSaveState] = useState<SaveState>('idle');
  // 启动连接探测是否完成 —— 完成前顶栏显示「连接中…」。
  const [probing, setProbing] = useState(true);
  // 文件结构面板是否展开（调试用，查看白板背后的文件目录）。
  const [folderViewOpen, setFolderViewOpen] = useState(false);
  // 防止 React 18 StrictMode 下 effect 跑两遍而重复探测/重复载入。
  const probedRef = useRef(false);

  // 用 ref 持有最新的 loadFromServer，供 SSE 回调闭包稳定引用。
  const loadFromServerRef = useRef(loadFromServer);
  loadFromServerRef.current = loadFromServer;

  // 自动保存：防抖计时器 + 上次见到的 importTick（用于区分「本地画布编辑」
  // 与「导入 / server 载入」—— 后者会自增 importTick，不应被回存）。
  const saveTimerRef = useRef<number | undefined>(undefined);
  const lastTickRef = useRef(0);

  // ── 启动时探测 board-server（整个生命周期仅一次）──────────────
  // probedRef 保证只探测一次（含 StrictMode 二次挂载）。
  // 不要用 effect cleanup 的 cancelled 标志中断探测 —— StrictMode 会在
  // 首次 effect 后立刻 cleanup，会把唯一一次探测掐死，导致永远停在「连接中…」。
  useEffect(() => {
    if (probedRef.current) return;
    probedRef.current = true;

    void (async () => {
      try {
        // 先 health 探活，再取白板数据。任一步失败都降级到离线模式。
        await checkHealth();
        const data = await fetchBoard();
        loadFromServer(data.meta, data.scene, data.files, data.tasks, 'initial');
      } catch (err) {
        // server 宕机 / 网络错误 / 数据非法 —— 优雅降级到离线模式，不崩。
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

  // ── 已连接模式下订阅 SSE，server 变化时刷新白板 ───────────────
  useEffect(() => {
    if (connection !== 'connected') return;

    // 收到 board-changed → 重新拉取白板并替换内存场景。
    // 重新拉取失败（server 临时不可达）不报错 —— 保留当前场景，等下次事件。
    const handleBoardChanged = (): void => {
      void (async () => {
        try {
          const data = await fetchBoard();
          loadFromServerRef.current(
            data.meta,
            data.scene,
            data.files,
            data.tasks,
            'refresh',
          );
        } catch (err) {
          console.info('[board-web] 收到变更事件但刷新白板失败，保留当前场景：', err);
        }
      })();
    };

    const unsubscribe = subscribeBoardEvents(handleBoardChanged);
    return unsubscribe;
  }, [connection]);

  // ── 本地画布编辑自动保存 ─────────────────────────────────────────
  // 画布上画的图形 / 连线 / 文本等只更新内存场景，不经 server reconcile
  // 持久化 —— 不自动保存的话刷新就丢。这里在场景变化后防抖 800ms putScene。
  // 仅本地编辑触发：导入 / server 载入会自增 importTick，据此跳过，避免把
  // server 刚下发的数据又原样回存（回声）。
  useEffect(() => {
    if (connection !== 'connected') return;
    if (importTick !== lastTickRef.current) {
      // 本次场景变化来自导入 / server 载入 —— 不回存。
      lastTickRef.current = importTick;
      return;
    }
    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      setSaveState('saving');
      void putScene(scene)
        .then(() => {
          setSaveState('saved');
          window.setTimeout(() => setSaveState('idle'), 1500);
        })
        .catch((err) => {
          setSaveState('error');
          console.warn('[board-web] 自动保存失败（可手动点保存）：', err);
          window.setTimeout(() => setSaveState('idle'), 2000);
        });
    }, 800);
    return () => window.clearTimeout(saveTimerRef.current);
  }, [scene, importTick, connection]);

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

  // ── 保存到 server（已连接模式下手动触发）────────────────────
  const handleSave = useCallback(async () => {
    if (connection !== 'connected') return;
    setSaveState('saving');
    try {
      await putScene(scene);
      setSaveState('saved');
      // 「已保存」提示 2 秒后回落到 idle。
      window.setTimeout(() => setSaveState('idle'), 2000);
    } catch (err) {
      setSaveState('error');
      const msg = err instanceof ServerError ? err.message : String(err);
      window.alert(`保存失败：${msg}`);
      window.setTimeout(() => setSaveState('idle'), 2000);
    }
  }, [connection, scene]);

  return (
    <div className="app-shell">
      <TopBar
        boardName={meta.name}
        onRename={renameBoard}
        onImport={handleImport}
        onExport={handleExport}
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
        <BoardCanvas />
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
