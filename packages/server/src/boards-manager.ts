/**
 * BoardsManager —— 多 board 中继下的运行时增删管理（PRD §4.2）。
 *
 * server 启动期一次性把命令行 / 环境变量给的 .board 装进 Map，但生产场景里
 * 用户应当能：
 *  - 列出当前 server 托管的所有 board
 *  - 在线新建一个空白 board（HTTP 触发 → fs 建文件夹 → 装 runtime → 入 Map）
 *  - 在线删除一个 board（关 runtime → .board 移入 _trash/ → 出 Map）
 *
 * 本模块只管 Map 增删 + fs 创建 / 移动；HTTP 路由 / 权限校验由 http.ts 干。
 */
import { mkdir, rename, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createBoardFolder, loadBoard } from '@board/core/node';
import { createBoardRuntime, type BoardRuntime } from './runtime.js';

/** 单条 board 的对外摘要（list 端点返回的形态）。 */
export interface BoardSummary {
  id: string;
  name: string;
  dir: string;
  createdAt: string;
  updatedAt: string;
  /** 是否为 server 启动期的默认 board（URL 不带 ?board= 时连这个）。 */
  isDefault: boolean;
}

/** new board 时的入参。 */
export interface CreateBoardInput {
  name: string;
}

/** BoardsManager 对外契约 —— 也是 http.ts 注入参数的类型。 */
export interface BoardsManager {
  /** 列出当前 Map 中的全部 board，按 server 启动 / 创建顺序。 */
  list(): BoardSummary[];
  /** 通过 boardId 拿对应 runtime；找不到返 undefined。 */
  get(id: string): BoardRuntime | undefined;
  /** 默认 boardId —— 启动期第一个 board 的 id；删除时若它走了下一个递补。 */
  getDefaultId(): string;
  /** 新建一个 .board + 装 runtime + 入 Map；返回新 board 的摘要。 */
  create(input: CreateBoardInput): Promise<BoardSummary>;
  /** 关 runtime + .board 移 _trash + 出 Map。删默认 board 后默认顺序递补到下一个。 */
  delete(id: string): Promise<void>;
}

/** 从 dir basename 派生 boardId —— 与 index.ts 同款（避免循环依赖故内部留一份）。 */
function deriveBoardId(dir: string): string {
  const base = basename(dir).replace(/\.board$/i, '');
  return base || 'board';
}

/**
 * 校验 board 名称 —— 仅允许字母 / 数字 / 中文 / `_-. 空格`；禁止路径分隔符 / 控制字符 /
 * 前后空白。返 null 表示通过，返字符串是错误原因。
 *
 * Why: name 直接拼成目录名 `<name>.board`，必须挡掉路径穿越（`..`、`/`、`\`、`:`）和
 *      非法文件名字符；同时允许中文 / 常见标点以匹配现有 demo board 的命名。
 */
function validateBoardName(name: string): string | null {
  if (typeof name !== 'string') return 'name 必须是字符串';
  const trimmed = name.trim();
  if (!trimmed) return 'name 不能为空';
  if (trimmed !== name) return 'name 首尾不能有空白';
  if (trimmed.length > 64) return 'name 长度超过 64';
  // 显式黑名单：路径分隔符 / 盘符 / 控制字符 / Windows 保留字符
  if (/[\\/:*?"<>|]/.test(trimmed)) return 'name 含非法字符（\\ / : * ? " < > | 之一）';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(trimmed)) return 'name 含控制字符';
  if (trimmed === '.' || trimmed === '..') return 'name 不能是 . 或 ..';
  return null;
}

export interface CreateBoardsManagerOptions {
  /** 初始 runtimes（按启动顺序）—— 第一项的 id 为默认 board。 */
  initial: BoardRuntime[];
  /** 新建 board 时的父目录绝对路径。 */
  boardsRoot: string;
}

export function createBoardsManager(
  opts: CreateBoardsManagerOptions,
): BoardsManager {
  const { initial, boardsRoot } = opts;
  if (initial.length === 0) {
    throw new Error('createBoardsManager 至少需要一个初始 board');
  }
  const runtimes = new Map<string, BoardRuntime>();
  const order: string[] = [];
  for (const rt of initial) {
    runtimes.set(rt.boardId, rt);
    order.push(rt.boardId);
  }
  let defaultId = order[0]!;

  function summaryOf(rt: BoardRuntime): BoardSummary {
    const meta = rt.deps.getMeta();
    return {
      id: rt.boardId,
      name: meta.name,
      dir: rt.dir,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      isDefault: rt.boardId === defaultId,
    };
  }

  return {
    list(): BoardSummary[] {
      return order.map((id) => summaryOf(runtimes.get(id)!));
    },

    get(id: string): BoardRuntime | undefined {
      return runtimes.get(id);
    },

    getDefaultId(): string {
      return defaultId;
    },

    async create(input: CreateBoardInput): Promise<BoardSummary> {
      const reason = validateBoardName(input.name);
      if (reason) throw new Error(reason);
      const name = input.name.trim();
      const targetDir = resolve(join(boardsRoot, `${name}.board`));
      // 目标父目录必须仍在 boardsRoot 内 —— 防御 name 里塞了奇怪东西穿越（虽然
      // validate 已经挡了 / 和 \，但 path normalize 的边界自留一层）。
      if (dirname(targetDir) !== resolve(boardsRoot)) {
        throw new Error('name 解析后越界 boardsRoot');
      }
      // 已存在则 409 语义（让 http 层翻译）
      try {
        await stat(targetDir);
        throw new Error(`同名 .board 已存在: ${targetDir}`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      const boardId = deriveBoardId(targetDir);
      if (runtimes.has(boardId)) {
        throw new Error(`boardId 冲突: ${boardId}`);
      }
      await mkdir(boardsRoot, { recursive: true });
      const dir = await createBoardFolder(boardsRoot, name);
      // sanity check：能 loadBoard 才算建好
      await loadBoard(dir);
      const rt = await createBoardRuntime({ boardId, dir });
      runtimes.set(boardId, rt);
      order.push(boardId);
      return summaryOf(rt);
    },

    async delete(id: string): Promise<void> {
      const rt = runtimes.get(id);
      if (!rt) throw new Error(`board 不存在: ${id}`);
      if (runtimes.size <= 1) {
        throw new Error('至少要保留一个 board，不能删最后一个');
      }

      // 先关 runtime（释放 watcher + ws + 定时器），再等一会儿让 Windows
      // 完成 chokidar 文件句柄释放（Windows 上 watcher.close() 返回后偶发
      // 仍握句柄几十 ms，导致 rename EBUSY）。
      await rt.close();
      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      // .board 移到 _trash/<timestamp>-<basename>。重试 3 次带退避 —— 修
      // Windows 句柄释放延迟引发的 EBUSY / EPERM。
      const trashRoot = join(boardsRoot, '_trash');
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const target = join(trashRoot, `${ts}-${basename(rt.dir)}`);
      let renameErr: unknown = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await mkdir(trashRoot, { recursive: true });
          await rename(rt.dir, target);
          renameErr = null;
          break;
        } catch (err) {
          renameErr = err;
          if (attempt < 2) {
            await new Promise<void>((resolve) =>
              setTimeout(resolve, 250 * (attempt + 1)),
            );
          }
        }
      }

      // 关键：rename 成功后才从 Map 移除，保证"Map 状态"与"磁盘状态"一致。
      // 即便 rename 失败，runtime 已停 → 同时从 Map 移除避免悬挂（用户重试
      // 也是新一轮独立的尝试，没必要保留死掉的 runtime）。
      runtimes.delete(id);
      const i = order.indexOf(id);
      if (i >= 0) order.splice(i, 1);
      if (id === defaultId && order.length > 0) defaultId = order[0]!;

      if (renameErr) {
        throw new Error(
          `已从激活列表移除，但磁盘文件夹未能移入 _trash（多次重试失败，` +
            `通常是 Windows chokidar 句柄释放延迟）。建议手动 rm 该文件夹` +
            ` 或重启 server 重新加载该 board。原始错误：${
              renameErr instanceof Error ? renameErr.message : String(renameErr)
            }`,
        );
      }
    },
  };
}
