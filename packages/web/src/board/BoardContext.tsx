/**
 * 白板状态层 — 用 React Context 持有一份 @board/core 的 `BoardScene` 与 `BoardMeta`。
 *
 * M1 单人白板：内存里维护一份场景，作为 board.json 的唯一真相源（source of truth）。
 *  - Excalidraw 变更 → `replaceScene` 写回内存场景。
 *  - 导入 board.json → `loadScene` 替换内存场景，并触发 Excalidraw 重渲染。
 *
 * 该层不直接依赖 Excalidraw —— 桥接由 App 层串联，保持状态层纯净。
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

export interface BoardContextValue {
  /** 内存中的场景（board.json 的真相源）。 */
  scene: BoardScene;
  /** 白板元数据（meta.json）。 */
  meta: BoardMeta;
  /** 当前参与者 id。 */
  actorId: ParticipantId;
  /**
   * 用新场景替换内存场景。
   * @param source 变更来源：`canvas` 来自 Excalidraw 同步，`import` 来自导入文件。
   */
  replaceScene: (next: BoardScene, source: 'canvas' | 'import') => void;
  /** 改白板名（写入 meta）。 */
  renameBoard: (name: string) => void;
  /**
   * 「导入版本号」——每次导入 board.json 自增。
   * App 层据此把导入的场景推送进 Excalidraw（区别于画布自身的变更）。
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

  const value = useMemo<BoardContextValue>(
    () => ({
      scene,
      meta,
      actorId: LOCAL_USER_ID,
      replaceScene,
      renameBoard,
      importTick,
    }),
    [scene, meta, replaceScene, renameBoard, importTick],
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
