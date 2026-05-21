/**
 * 白板状态层 — 用 React Context 持有一份 @board/core 的 `BoardScene` 与 `BoardMeta`。
 *
 * 内存里维护一份场景，作为 board.json 的唯一真相源（source of truth）。
 *  - 画布 / 覆盖层编辑 → `replaceScene(...,'canvas')` 写回内存场景。
 *  - 导入 board.json → `replaceScene(...,'import')` 替换内存场景并触发重渲染。
 *  - server 数据载入 → `loadFromServer` 替换内存场景并进入「已连接」模式。
 *
 * 连接模式（M1 web ⇄ server 对接）：
 *  - `offline` —— server 不可达，保留空白板 + 导入/导出兜底。
 *  - `connected` —— 已载入 server 持有的真实 .board，「保存」按钮可用。
 *
 * 该层不直接依赖画布渲染与网络层 —— 渲染与 server 交互由上层串联，
 * 保持状态层纯净。
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  type BoardScene,
  type BoardMeta,
  type BoardOp,
  type BoardTask,
  type ParticipantId,
  applyOps,
  createBoardScene,
  createBoardMeta,
} from '@board/core';

/** 当前单人白板的参与者 id（M1 固定一个本地用户）。 */
export const LOCAL_USER_ID: ParticipantId = 'u_local';

/** 连接模式 —— 决定是否启用 server 保存与「已连接」指示。 */
export type ConnectionMode = 'offline' | 'connected';

/** 撤销 / 重做历史栈的最大深度。 */
const HISTORY_CAP = 100;

export interface BoardContextValue {
  /** 内存中的场景（board.json 的真相源）。 */
  scene: BoardScene;
  /** 白板元数据（meta.json）。 */
  meta: BoardMeta;
  /** 当前参与者 id。 */
  actorId: ParticipantId;
  /** 当前连接模式。 */
  connection: ConnectionMode;
  /** server 持有的文件列表（相对 files/ 的路径）；离线模式下为空。 */
  serverFiles: string[];
  /** Agent 任务（Pencil 式过程可视化，M3）；离线模式下为空。 */
  tasks: BoardTask[];
  /**
   * 用新场景替换内存场景。
   * @param source 变更来源：
   *   - `canvas` —— 来自画布 / 覆盖层的本地编辑；
   *   - `import` —— 来自导入文件（聚焦到全部内容）。
   */
  replaceScene: (next: BoardScene, source: 'canvas' | 'import') => void;
  /** 改白板名（写入 meta）。 */
  renameBoard: (name: string) => void;
  /**
   * 载入 server 持有的白板，进入「已连接」模式。
   * 替换内存的 scene/meta 并触发重渲染（同 import）。
   * @param mode `initial` 首次连接（视图缩放到全部内容）；
   *             `refresh` SSE 后台刷新（保持当前视野不跳动）。
   */
  loadFromServer: (
    meta: BoardMeta,
    scene: BoardScene,
    files: string[],
    tasks: BoardTask[],
    mode: 'initial' | 'refresh',
  ) => void;
  /**
   * 应用一批来自其他端的元素级操作（M4 实时同步）。
   * 按元素 id 合并进内存场景 —— 不整板覆盖，故不会冲掉本端未同步的编辑。
   */
  applyRemoteOps: (ops: BoardOp[]) => void;
  /**
   * 「导入版本号」——每次导入 board.json / 载入 server 数据 / 应用远端 ops 自增。
   * App 层据此判定本次场景变化非本地编辑、不回发 server；CanvasShell 据此
   * 在导入 / 首次连接时把视口聚焦到内容。
   */
  importTick: number;
  /**
   * 当前 importTick 对应的变更是否应把视图聚焦到全部内容。
   * 用户导入 / 首次连接 → true；SSE 后台刷新 → false（不打扰当前视野）。
   */
  importFit: boolean;
  /** 撤销上一步本地编辑（基于场景快照栈）。 */
  undo: () => void;
  /** 重做上一步被撤销的编辑。 */
  redo: () => void;
  /** 是否有可撤销的步骤。 */
  canUndo: boolean;
  /** 是否有可重做的步骤。 */
  canRedo: boolean;
}

const BoardContext = createContext<BoardContextValue | null>(null);

export interface BoardProviderProps {
  children: ReactNode;
  /** 初始白板名。 */
  initialName?: string;
}

/** 白板状态 Provider —— 应用根部挂一次。 */
export function BoardProvider({
  children,
  initialName = '未命名白板',
}: BoardProviderProps): JSX.Element {
  const [scene, setScene] = useState<BoardScene>(() => createBoardScene());
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
  // importState.tick 每次导入 / 载入 server 数据 / 应用远端 ops 自增；
  // fit 表示该次是否应聚焦到全部内容（区分用户导入与 SSE 后台刷新）。
  const [importState, setImportState] = useState<{ tick: number; fit: boolean }>(
    { tick: 0, fit: false },
  );
  const [connection, setConnection] = useState<ConnectionMode>('offline');
  const [serverFiles, setServerFiles] = useState<string[]>([]);
  const [tasks, setTasks] = useState<BoardTask[]>([]);

  // 用 ref 持有最新场景，供 replaceScene 的闭包同步读取（避免闭包陈旧）。
  const sceneRef = useRef(scene);
  sceneRef.current = scene;

  // 撤销 / 重做历史 —— 场景快照栈（自研画布层增量5）。
  const undoRef = useRef<BoardScene[]>([]);
  const redoRef = useRef<BoardScene[]>([]);
  // 历史版本号 —— 自增以让 canUndo/canRedo 重新求值（栈是 ref，本身不触发渲染）。
  const [histTick, setHistTick] = useState(0);

  const replaceScene = useCallback(
    (next: BoardScene, source: 'canvas' | 'import') => {
      if (source === 'canvas') {
        // 本地编辑 —— 变更前的场景压入撤销栈，清空重做栈。
        undoRef.current.push(sceneRef.current);
        if (undoRef.current.length > HISTORY_CAP) undoRef.current.shift();
        redoRef.current = [];
        setHistTick((t) => t + 1);
      }
      setScene(next);
      setMeta((m) => ({ ...m, updatedAt: new Date().toISOString() }));
      if (source === 'import') {
        setImportState((s) => ({ tick: s.tick + 1, fit: true }));
      }
    },
    [],
  );

  /** 撤销 —— 弹出撤销栈顶并恢复；当前场景压入重做栈。 */
  const undo = useCallback(() => {
    const prev = undoRef.current.pop();
    if (!prev) return;
    redoRef.current.push(sceneRef.current);
    setScene(prev);
    setMeta((m) => ({ ...m, updatedAt: new Date().toISOString() }));
    setHistTick((t) => t + 1);
  }, []);

  /** 重做 —— 弹出重做栈顶并恢复；当前场景压回撤销栈。 */
  const redo = useCallback(() => {
    const next = redoRef.current.pop();
    if (!next) return;
    undoRef.current.push(sceneRef.current);
    setScene(next);
    setMeta((m) => ({ ...m, updatedAt: new Date().toISOString() }));
    setHistTick((t) => t + 1);
  }, []);

  const renameBoard = useCallback((name: string) => {
    setMeta((m) => ({ ...m, name, updatedAt: new Date().toISOString() }));
  }, []);

  const applyRemoteOps = useCallback((ops: BoardOp[]) => {
    if (ops.length === 0) return;
    setScene((s) => applyOps(s, ops));
    setMeta((m) => ({ ...m, updatedAt: new Date().toISOString() }));
    // importTick 自增 —— 标记为非本地编辑、不回发 server；保持当前视野。
    setImportState((s) => ({ tick: s.tick + 1, fit: false }));
  }, []);

  const loadFromServer = useCallback(
    (
      nextMeta: BoardMeta,
      nextScene: BoardScene,
      files: string[],
      nextTasks: BoardTask[],
      mode: 'initial' | 'refresh',
    ) => {
      setMeta(nextMeta);
      setScene(nextScene);
      setServerFiles(files);
      setTasks(nextTasks);
      setConnection('connected');
      if (mode === 'initial') {
        // 首次连接 / 切换白板 —— 旧白板的历史已无意义，清空。
        undoRef.current = [];
        redoRef.current = [];
        setHistTick((t) => t + 1);
      }
      // importTick 自增触发重渲染；仅首次连接聚焦到全部内容，刷新保持视野。
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
      applyRemoteOps,
      importTick: importState.tick,
      importFit: importState.fit,
      undo,
      redo,
      canUndo: undoRef.current.length > 0,
      canRedo: redoRef.current.length > 0,
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
      applyRemoteOps,
      importState,
      undo,
      redo,
      histTick,
    ],
  );

  return (
    <BoardContext.Provider value={value}>{children}</BoardContext.Provider>
  );
}

/** 读取白板状态。必须在 `BoardProvider` 之内调用。 */
export function useBoard(): BoardContextValue {
  const ctx = useContext(BoardContext);
  if (!ctx) {
    throw new Error('useBoard 必须在 <BoardProvider> 之内使用');
  }
  return ctx;
}
