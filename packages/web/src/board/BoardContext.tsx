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
 * 撤销 / 重做（按 2026-05-23 决策「先单端」）：栈在 BoardContext 维护，
 * 每个浏览器 tab 各持一份；撤销时把旧场景经 diff 应用回 Y.Doc 同步给所有
 * 端。同一人多端不共享撤销栈、撤销可能覆盖其它端的并发改动 —— 已接受。
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

/** 当前单人白板的参与者 id（M1 固定一个本地用户）。 */
export const LOCAL_USER_ID: ParticipantId = 'u_local';

/** 连接模式。 */
export type ConnectionMode = 'offline' | 'connected';

/** 撤销 / 重做历史栈的最大深度。 */
const HISTORY_CAP = 100;

/** ws URL —— 同源 host，端口固定 4500（PRD §12，本地服务）。 */
function defaultYjsUrl(): string {
  const loc = window.location;
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${loc.hostname}:4500/yjs`;
}

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
    clientRef.current = createYjsClient({ url: defaultYjsUrl() });
  }
  const client = clientRef.current;

  // 用 ref 缓存最新的 scene 投影。Y.Doc 每次更新都重算这份缓存 —— 给
  // useSyncExternalStore 的 getSnapshot 返回稳定引用（每次返回同一对象
  // 直到下次 Y.Doc 更新），避免无限重渲染。
  const sceneCacheRef = useRef<BoardScene>(yDocToScene(client.doc));
  useEffect(() => {
    const handler = (): void => {
      sceneCacheRef.current = yDocToScene(client.doc);
    };
    client.doc.on('update', handler);
    return () => {
      client.doc.off('update', handler);
    };
  }, [client]);

  const scene = useSyncExternalStore(
    useCallback(
      (cb) => {
        const handler = (): void => cb();
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
  const [serverFiles, setServerFiles] = useState<string[]>([]);
  const [tasks, setTasks] = useState<BoardTask[]>([]);

  // 连接状态从 yjs-client 派生 —— ws 连上即 connected
  const [wsStatus, setWsStatus] = useState<YjsClientStatus>(client.getStatus());
  useEffect(() => {
    return client.subscribeStatus(setWsStatus);
  }, [client]);
  const connection: ConnectionMode = wsStatus === 'connected' ? 'connected' : 'offline';

  // 撤销 / 重做：场景快照栈（按你 2026-05-23 决策「先单端」）
  const undoRef = useRef<BoardScene[]>([]);
  const redoRef = useRef<BoardScene[]>([]);
  const [histTick, setHistTick] = useState(0);

  // 远端改动经 Y.Doc 进来时（origin 不是 'local-edit'），不应进撤销栈，
  // 也不应触发"导入"语义。但我们需要让 importTick 在元数据被替换时（如
  // server 端 refresh）才自增。所以远端 Y.Doc 更新只刷场景、不动栈与 tick。
  // 这里不需要额外 hook —— sceneCacheRef + useSyncExternalStore 已处理。

  /** 内部：把新场景 diff 进 Y.Doc，origin 标记 'local-edit'。 */
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
      const cur = sceneCacheRef.current;
      if (source === 'canvas') {
        undoRef.current.push(cur);
        if (undoRef.current.length > HISTORY_CAP) undoRef.current.shift();
        redoRef.current = [];
        setHistTick((t) => t + 1);
      }
      applyToYDoc(next, source === 'import' ? 'local-import' : 'local-edit');
      setMeta((m) => ({ ...m, updatedAt: new Date().toISOString() }));
      if (source === 'import') {
        setImportState((s) => ({ tick: s.tick + 1, fit: true }));
      }
    },
    [applyToYDoc],
  );

  const undo = useCallback(() => {
    const prev = undoRef.current.pop();
    if (!prev) return;
    redoRef.current.push(sceneCacheRef.current);
    applyToYDoc(prev, 'local-undo');
    setMeta((m) => ({ ...m, updatedAt: new Date().toISOString() }));
    setHistTick((t) => t + 1);
  }, [applyToYDoc]);

  const redo = useCallback(() => {
    const next = redoRef.current.pop();
    if (!next) return;
    undoRef.current.push(sceneCacheRef.current);
    applyToYDoc(next, 'local-redo');
    setMeta((m) => ({ ...m, updatedAt: new Date().toISOString() }));
    setHistTick((t) => t + 1);
  }, [applyToYDoc]);

  const renameBoard = useCallback((name: string) => {
    setMeta((m) => ({ ...m, name, updatedAt: new Date().toISOString() }));
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
        undoRef.current = [];
        redoRef.current = [];
        setHistTick((t) => t + 1);
      }
      setImportState((s) => ({ tick: s.tick + 1, fit: mode === 'initial' }));
    },
    [],
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
      undo,
      redo,
      canUndo: undoRef.current.length > 0,
      canRedo: redoRef.current.length > 0,
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
      undo,
      redo,
      histTick,
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
