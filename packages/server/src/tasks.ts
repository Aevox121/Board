/**
 * 任务运行时存储 — Pencil 式过程可视化（PRD §7.4）。
 *
 * 任务是 Agent 工作的「过程」态，不属于 board.json（成果）。本模块把任务存于
 * `.board/.runtime/tasks.json`：reconcile R7 把 `.runtime/` 列为忽略项，故不会
 * 生成文件元素、也不与 files/ 同步。内存持有一份，变更即持久化，服务重启可恢复。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BoardTask } from '@board/core';

/** 运行时目录与任务文件名。 */
const RUNTIME_DIR = '.runtime';
const TASKS_FILE = 'tasks.json';

/** 任务存储对外句柄。 */
export interface TaskStore {
  /** 当前所有任务（按创建时间升序）。 */
  list(): BoardTask[];
  /** 取单个任务。 */
  get(id: string): BoardTask | undefined;
  /** 写入 / 更新一个任务并持久化。 */
  put(task: BoardTask): Promise<void>;
}

/** 从 `.board/.runtime/tasks.json` 载入并创建任务存储。 */
export async function createTaskStore(dir: string): Promise<TaskStore> {
  const filePath = join(dir, RUNTIME_DIR, TASKS_FILE);
  const tasks = new Map<string, BoardTask>();

  // 载入已有运行时任务（文件缺失 / 损坏均按空处理，不中断启动）。
  try {
    const raw: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    if (Array.isArray(raw)) {
      for (const t of raw) {
        if (t && typeof t === 'object' && typeof (t as BoardTask).id === 'string') {
          tasks.set((t as BoardTask).id, t as BoardTask);
        }
      }
    }
  } catch {
    // 无 .runtime/tasks.json —— 空存储。
  }

  async function persist(): Promise<void> {
    await mkdir(join(dir, RUNTIME_DIR), { recursive: true });
    const ordered = [...tasks.values()].sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
    );
    await writeFile(filePath, JSON.stringify(ordered, null, 2), 'utf8');
  }

  return {
    list() {
      return [...tasks.values()].sort((a, b) =>
        a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
      );
    },
    get(id) {
      return tasks.get(id);
    },
    async put(task) {
      tasks.set(task.id, task);
      await persist();
    },
  };
}
