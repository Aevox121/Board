/**
 * 白板状态层 —— 经 Yjs 协同与 server 实时同步（M4 增量3）。
 *
 * scene 从本地 Y.Doc 派生（每次 Y.Doc 更新都重算缓存快照），保证 React
 * 渲染拿到的是最新的纯 JS 投影。所有写操作经 replaceScene 落入 Y.Doc：
 *   - 'canvas'：本地编辑 —— 压入撤销栈再 diff 应用到 Y.Doc
 *   - 'import'：导入 / 重置 —— 不入撤销栈，整场景替换
 * Y.Doc update 经 yjs-client 自动 ws 发往 server；远端改动经 ws 进本地
 * Y.Doc，触发场景缓存刷新与重渲染。
 *
 * 连接模式 —— 当 yjs-client 连上且 HTTP /api/board 元数据已载入时为
 * 'connected'；任一未就绪则 'offline'。
 *
 * 撤销 / 重做（PRD §8.5「每人独立 undo/redo」）：用 Y.UndoManager 接管。
 * trackedOrigins 仅含 'local-edit' —— 撤销只回退**本地用户的本地操作**，
 * 不动远端（其他人 / Agent 流式 / 服务端 reconcile）的并发改动。撤销栈
 * 在 BoardContext 维护，每个浏览器 tab 各持一份（同一人多 tab 不共享，
 * 但因 UndoManager 按 op 反向、不再整场景覆盖，多 tab 之间也不会互相
 * 抹掉对方的改动）。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import * as Y from 'yjs';
import {
  type BoardScene,
  type BoardMeta,
  type BoardTask,
  type ParticipantId,
  applySceneDiff,
  createBoardScene,
  createBoardMeta,
  yDocToScene,
} from '@board/core';
import { createYjsClient, type YjsClient, type YjsClientStatus } from './yjs-client';
import { yjsWsUrl } from '../server/boardSession';
import { record } from '../canvas/perfLog';

/** 当前单人白板的参与者 id（M1 固定一个本地用户）。 */
export const LOCAL_USER_ID: ParticipantId = 'u_local';

/** 连接模式。 */
export type ConnectionMode = 'offline' | 'connected';

/**
 * 本地编辑的 origin —— 经 Y.Doc.transact(..., LOCAL_EDIT_ORIGIN) 落入文档。
 * UndoManager 仅追踪此 origin 的 op，保证 undo 不动远端并发改动。
 */
const LOCAL_EDIT_ORIGIN = 'local-edit';
/** 非本地导入 / 重置场景的 origin —— 不入 undo（导入是新起点）。 */
const LOCAL_IMPORT_ORIGIN = 'local-import';

/**
 * Y.UndoManager 把短时窗内的连续 op 合并为同一撤销组的窗口（毫秒）。
 * 一次 replaceScene 已经是一个 transact —— 此值只影响多次快速 replaceScene
 * 合并到一起的行为；500ms 与 Y 默认一致，足够把"拖动结束"和"立刻又一次微调"
 * 合并，不至于让用户多按几下 Ctrl+Z。
 */
const UNDO_CAPTURE_MS = 500;

export interface BoardContextValue {
  scene: BoardScene;
  meta: BoardMeta;
  actorId: ParticipantId;
  connection: ConnectionMode;
  serverFiles: string[];
  tasks: BoardTask[];
  /**
   * 用新场景替换内存场景。
   * @param source canvas（本地编辑，入撤销栈）/ import（整场景重置，跳栈）
   */
  replaceScene: (next: BoardScene, source: 'canvas' | 'import') => void;
  renameBoard: (name: string) => void;
  /**
   * 载入 server 持有的元数据（首次连接 / SSE board-changed 后刷新）。
   * 不再传 scene —— 场景由 Y.Doc 自动经 ws 同步。
   */
  loadFromServer: (
    meta: BoardMeta,
    files: string[],
    tasks: BoardTask[],
    mode: 'initial' | 'refresh',
  ) => void;
  /** 「导入版本号」—— 用户导入 / 首次连接时自增，让 CanvasShell 聚焦视野。 */
  importTick: number;
  importFit: boolean;
  /**
   * 「导航请求」—— OutlinePanel / 搜索结果等任意 UI 请求把视口跳到某元素。
   * 自增 tick + 设 target id；CanvasShell 监听 tick 变化即把视口居中到该元素。
   */
  navTick: number;
  navTargetId: string | null;
  requestNavigateToElement: (elementId: string) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** 暴露 Yjs 文档（编辑器绑定 Y.Text 用 / 调试用）。 */
  yDoc: Y.Doc;
}

const BoardContext = createContext<BoardContextValue | null>(null);

export interface BoardProviderProps {
  children: ReactNode;
  initialName?: string;
}

export function BoardProvider({
  children,
  initialName = '未命名白板',
}: BoardProviderProps): JSX.Element {
  // Yjs client：渲染期 lazy 创建一次，组件生命周期内复用。
  // 不在 useEffect cleanup 里 disconnect ——React StrictMode 双挂载会把
  // 首次创建的 client 立刻 disconnect 掉，导致 ws 永久关闭。让 ws 活到
  // 浏览器 tab 关闭（自动断开），属可接受的小代价。
  const clientRef = useRef<YjsClient | null>(null);
  if (clientRef.current === null) {
    clientRef.current = createYjsClient({ url: yjsWsUrl() });
  }
  const client = clientRef.current;

  // 用 ref 缓存最新的 scene 投影。Y.Doc 每次更新都重算这份缓存 —— 给
  // useSyncExternalStore 的 getSnapshot 返回稳定引用（每次返回同一对象
  // 直到下次 Y.Doc 更新），避免无限重渲染。
  const sceneCacheRef = useRef<BoardScene>(yDocToScene(client.doc));
  useEffect(() => {
    const handler = (_update: Uint8Array, origin: unknown): void => {
      record('YDoc.update');
      record(`YDoc.update[${String(origin) || 'unknown'}]`);
      const t0 = performance.now();
      sceneCacheRef.current = yDocToScene(client.doc);
      record('yDocToScene', performance.now() - t0);
    };
    client.doc.on('update', handler);
    return () => {
      client.doc.off('update', handler);
    };
  }, [client]);

  const scene = useSyncExternalStore(
    useCallback(
      (cb) => {
        const handler = (): void => {
          record('BoardCtx.scene-cb');
          cb();
        };
        client.doc.on('update', handler);
        return () => {
          client.doc.off('update', handler);
        };
      },
      [client],
    ),
    () => sceneCacheRef.current,
    () => sceneCacheRef.current,
  );
  record('BoardCtx.render');

  const [meta, setMeta] = useState<BoardMeta>(() =>
    createBoardMeta({
      name: initialName,
      participants: [
        {
          id: LOCAL_USER_ID,
          type: 'human',
          name: '我',
          color: '#d97757',
          ownerId: null,
          avatar: null,
        },
      ],
    }),
  );
  const [importState, setImportState] = useState<{ tick: number; fit: boolean }>(
    { tick: 0, fit: false },
  );
  const [navState, setNavState] = useState<{
    tick: number;
    targetId: string | null;
  }>({ tick: 0, targetId: null });
  const [serverFiles, setServerFiles] = useState<string[]>([]);
  const [tasks, setTasks] = useState<BoardTask[]>([]);

  // 连接状态从 yjs-client 派生 —— ws 连上即 connected
  const [wsStatus, setWsStatus] = useState<YjsClientStatus>(client.getStatus());
  useEffect(() => {
    return client.subscribeStatus(setWsStatus);
  }, [client]);
  const connection: ConnectionMode = wsStatus === 'connected' ? 'connected' : 'offline';

  // 撤销 / 重做：Y.UndoManager（PRD §8.5）
  //
  // 只追踪本地 'local-edit' origin —— 远端 / Agent / server reconcile 的并发
  // op 不进栈；undo 反向回放本地 op，不会动到别人的工作。
  //
  // typeScope = 'elements' map —— 不含 viewport（视口是局部状态，不应被撤销
  // 反弹）；UndoManager 自动跟踪嵌套（每个元素自身的 Y.Map / 内嵌 Y.Text）。
  const undoManagerRef = useRef<Y.UndoManager | null>(null);
  if (undoManagerRef.current === null) {
    undoManagerRef.current = new Y.UndoManager(
      client.doc.getMap<Y.Map<unknown>>('elements'),
      {
        trackedOrigins: new Set([LOCAL_EDIT_ORIGIN]),
        captureTimeout: UNDO_CAPTURE_MS,
      },
    );
  }
  const undoManager = undoManagerRef.current;
  // canUndo / canRedo 由栈长度派生 —— 监 stack-item-added / popped / cleared。
  const [stackSize, setStackSize] = useState<{ undo: number; redo: number }>({
    undo: 0,
    redo: 0,
  });
  useEffect(() => {
    const refresh = (): void => {
      setStackSize({
        undo: undoManager.undoStack.length,
        redo: undoManager.redoStack.length,
      });
    };
    undoManager.on('stack-item-added', refresh);
    undoManager.on('stack-item-popped', refresh);
    undoManager.on('stack-cleared', refresh);
    return () => {
      undoManager.off('stack-item-added', refresh);
      undoManager.off('stack-item-popped', refresh);
      undoManager.off('stack-cleared', refresh);
    };
  }, [undoManager]);

  /** 内部：把新场景 diff 进 Y.Doc。origin 决定是否进 UndoManager 栈。 */
  const applyToYDoc = useCallback(
    (next: BoardScene, origin: string): void => {
      const old = sceneCacheRef.current;
      client.doc.transact(() => {
        applySceneDiff(client.doc, old, next);
      }, origin);
    },
    [client],
  );

  const replaceScene = useCallback(
    (next: BoardScene, source: 'canvas' | 'import') => {
      if (source === 'import') {
        // 导入 = 新起点：先 clear undo 栈，再以非追踪 origin 落入。
        undoManager.clear();
      }
      applyToYDoc(
        next,
        source === 'import' ? LOCAL_IMPORT_ORIGIN : LOCAL_EDIT_ORIGIN,
      );
      setMeta((m) => ({ ...m, updatedAt: new Date().toISOString() }));
      if (source === 'import') {
        setImportState((s) => ({ tick: s.tick + 1, fit: true }));
      }
    },
    [applyToYDoc, undoManager],
  );

  const undo = useCallback(() => {
    undoManager.undo();
    setMeta((m) => ({ ...m, updatedAt: new Date().toISOString() }));
  }, [undoManager]);

  const redo = useCallback(() => {
    undoManager.redo();
    setMeta((m) => ({ ...m, updatedAt: new Date().toISOString() }));
  }, [undoManager]);

  const renameBoard = useCallback((name: string) => {
    setMeta((m) => ({ ...m, name, updatedAt: new Date().toISOString() }));
  }, []);

  const requestNavigateToElement = useCallback((elementId: string) => {
    setNavState((s) => ({ tick: s.tick + 1, targetId: elementId }));
  }, []);

  const loadFromServer = useCallback(
    (
      nextMeta: BoardMeta,
      files: string[],
      nextTasks: BoardTask[],
      mode: 'initial' | 'refresh',
    ) => {
      setMeta(nextMeta);
      setServerFiles(files);
      setTasks(nextTasks);
      if (mode === 'initial') {
        // 首次连入 server：清空 UndoManager 栈（避免上一会话遗留）。
        undoManager.clear();
      }
      setImportState((s) => ({ tick: s.tick + 1, fit: mode === 'initial' }));
    },
    [undoManager],
  );

  const value = useMemo<BoardContextValue>(
    () => ({
      scene,
      meta,
      actorId: LOCAL_USER_ID,
      connection,
      serverFiles,
      tasks,
      replaceScene,
      renameBoard,
      loadFromServer,
      importTick: importState.tick,
      importFit: importState.fit,
      navTick: navState.tick,
      navTargetId: navState.targetId,
      requestNavigateToElement,
      undo,
      redo,
      canUndo: stackSize.undo > 0,
      canRedo: stackSize.redo > 0,
      yDoc: client.doc,
    }),
    [
      scene,
      meta,
      connection,
      serverFiles,
      tasks,
      replaceScene,
      renameBoard,
      loadFromServer,
      importState,
      navState,
      requestNavigateToElement,
      undo,
      redo,
      stackSize,
      client,
    ],
  );

  return (
    <BoardContext.Provider value={value}>{children}</BoardContext.Provider>
  );
}

export function useBoard(): BoardContextValue {
  const ctx = useContext(BoardContext);
  if (!ctx) {
    throw new Error('useBoard 必须在 <BoardProvider> 之内使用');
  }
  return ctx;
}
