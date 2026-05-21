/**
 * 白板状态层 — 用 React Context 持有一份 @board/core 的 `BoardScene` 与 `BoardMeta`。
 *
 * 内存里维护一份场景，作为 board.json 的唯一真相源（source of truth）。
 *  - Excalidraw 变更 → `replaceScene(...,'canvas')` 写回内存场景。
 *  - 导入 board.json → `replaceScene(...,'import')` 替换内存场景并触发重渲染。
 *  - server 数据载入 → `loadFromServer` 替换内存场景并进入「已连接」模式。
 *
 * 连接模式（M1 web ⇄ server 对接）：
 *  - `offline` —— server 不可达，保留空白板 + 导入/导出兜底。
 *  - `connected` —— 已载入 server 持有的真实 .board，「保存」按钮可用。
 *
 * 该层不直接依赖 Excalidraw 与网络层 —— 桥接与 server 交互由 App 层串联，
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
   *   - `canvas` —— 来自 Excalidraw / 覆盖层的本地编辑；
   *   - `import` —— 来自导入文件（缩放到全部内容）；
   *   - `canvas-sync` —— 覆盖层改动了 Excalidraw 原生元素（如拖区域带动其内
   *     图形），需把场景重推进 Excalidraw 让图形跟随；仍属本地编辑、照常自动同步。
   */
  replaceScene: (
    next: BoardScene,
    source: 'canvas' | 'import' | 'canvas-sync',
  ) => void;
  /** 改白板名（写入 meta）。 */
  renameBoard: (name: string) => void;
  /**
   * 载入 server 持有的白板，进入「已连接」模式。
   * 替换内存的 scene/meta，并触发一次 Excalidraw 重渲染（同 import）。
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
   * App 层据此把场景推送进 Excalidraw（区别于画布自身的变更），并据此判定
   * 本次场景变化非本地编辑、不回发 server。
   */
  importTick: number;
  /**
   * 当前 importTick 对应的变更是否应把视图缩放到全部内容。
   * 用户导入 / 首次连接 → true；SSE 后台刷新 → false（不打扰当前视野）。
   */
  importFit: boolean;
  /**
   * 「画布同步版本号」—— 覆盖层移动了 Excalidraw 原生元素（如拖区域带动其内
   * 图形）时自增。BoardCanvas 据此把场景重推进 Excalidraw 使图形跟随。
   * 与 importTick 不同：它不会被自动同步当作「server 来源」跳过 —— 仍是本地编辑。
   */
  syncTick: number;
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
  // importState.tick 自增即触发把场景推进 Excalidraw；
  // fit 表示该次是否应缩放到全部内容（区分用户导入与 SSE 后台刷新）。
  const [importState, setImportState] = useState<{ tick: number; fit: boolean }>(
    { tick: 0, fit: false },
  );
  const [connection, setConnection] = useState<ConnectionMode>('offline');
  const [serverFiles, setServerFiles] = useState<string[]>([]);
  const [tasks, setTasks] = useState<BoardTask[]>([]);
  // 画布同步版本号 —— 覆盖层动了 Excalidraw 原生元素时自增（见 syncTick 注释）。
  const [syncTick, setSyncTick] = useState(0);

  // 用 ref 持有最新场景，供 replaceScene 的闭包同步读取（避免闭包陈旧）。
  const sceneRef = useRef(scene);
  sceneRef.current = scene;

  const replaceScene = useCallback(
    (next: BoardScene, source: 'canvas' | 'import' | 'canvas-sync') => {
      setScene(next);
      setMeta((m) => ({ ...m, updatedAt: new Date().toISOString() }));
      if (source === 'import') {
        setImportState((s) => ({ tick: s.tick + 1, fit: true }));
      } else if (source === 'canvas-sync') {
        // 覆盖层动了 Excalidraw 原生元素 —— 触发 BoardCanvas 把场景重推进 Excalidraw。
        setSyncTick((n) => n + 1);
      }
    },
    [],
  );

  const renameBoard = useCallback((name: string) => {
    setMeta((m) => ({ ...m, name, updatedAt: new Date().toISOString() }));
  }, []);

  const applyRemoteOps = useCallback((ops: BoardOp[]) => {
    if (ops.length === 0) return;
    setScene((s) => applyOps(s, ops));
    setMeta((m) => ({ ...m, updatedAt: new Date().toISOString() }));
    // 复用 importTick 机制把场景推进 Excalidraw；保持当前视野、不回发 server。
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
      // 复用 importTick 机制把 server 场景推进 Excalidraw；
      // 仅首次连接缩放到全部内容，SSE 刷新保持当前视野。
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
      syncTick,
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
      syncTick,
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
