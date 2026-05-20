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
  type ParticipantId,
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
  /**
   * 用新场景替换内存场景。
   * @param source 变更来源：`canvas` 来自 Excalidraw 同步，`import` 来自导入文件。
   */
  replaceScene: (next: BoardScene, source: 'canvas' | 'import') => void;
  /** 改白板名（写入 meta）。 */
  renameBoard: (name: string) => void;
  /**
   * 载入 server 持有的白板，进入「已连接」模式。
   * 替换内存的 scene/meta，并触发一次 Excalidraw 重渲染（同 import）。
   */
  loadFromServer: (
    meta: BoardMeta,
    scene: BoardScene,
    files: string[],
  ) => void;
  /**
   * 「导入版本号」——每次导入 board.json 或载入 server 数据自增。
   * App 层据此把场景推送进 Excalidraw（区别于画布自身的变更）。
   */
  importTick: number;
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
  const [importTick, setImportTick] = useState(0);
  const [connection, setConnection] = useState<ConnectionMode>('offline');
  const [serverFiles, setServerFiles] = useState<string[]>([]);

  // 用 ref 持有最新场景，供 replaceScene 的闭包同步读取（避免闭包陈旧）。
  const sceneRef = useRef(scene);
  sceneRef.current = scene;

  const replaceScene = useCallback(
    (next: BoardScene, source: 'canvas' | 'import') => {
      setScene(next);
      setMeta((m) => ({ ...m, updatedAt: new Date().toISOString() }));
      if (source === 'import') {
        setImportTick((t) => t + 1);
      }
    },
    [],
  );

  const renameBoard = useCallback((name: string) => {
    setMeta((m) => ({ ...m, name, updatedAt: new Date().toISOString() }));
  }, []);

  const loadFromServer = useCallback(
    (nextMeta: BoardMeta, nextScene: BoardScene, files: string[]) => {
      setMeta(nextMeta);
      setScene(nextScene);
      setServerFiles(files);
      setConnection('connected');
      // 复用 importTick 机制把 server 场景推进 Excalidraw。
      setImportTick((t) => t + 1);
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
      replaceScene,
      renameBoard,
      loadFromServer,
      importTick,
    }),
    [
      scene,
      meta,
      connection,
      serverFiles,
      replaceScene,
      renameBoard,
      loadFromServer,
      importTick,
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
