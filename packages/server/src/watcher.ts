/**
 * 文件监听 — chokidar 监听 `<dir>/files/` 下的真实文件变化。
 *
 * M1 范围：仅监听 + 维护内存中的文件列表，并在变化时打印日志。
 * 完整的文件系统 ⇄ 画布双向同步（自动排版、元素增删、缺失态）属于 M2。
 */
import { join, relative, sep } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { isIgnoredPath, normalizePath } from '@board/core';

/** 文件变更类型。 */
export type FileChangeType = 'add' | 'unlink';

/** 一条文件变更事件。 */
export interface FileChangeEvent {
  type: FileChangeType;
  /** 规范化的相对路径（相对 files/） */
  path: string;
}

/** 监听器对外暴露的句柄。 */
export interface BoardWatcher {
  /** 返回当前内存中的文件列表快照（已排序的相对路径数组）。 */
  getFiles(): string[];
  /** 停止监听并释放资源。 */
  close(): Promise<void>;
}

/**
 * 启动对 `<dir>/files/` 的监听。
 *
 * @param dir       .board 目录绝对路径
 * @param initial   初始文件列表（通常来自 listBoardFiles）
 * @param onChange  可选：每次文件列表变化后回调，便于上层广播
 */
export function startWatcher(
  dir: string,
  initial: string[],
  onChange?: (event: FileChangeEvent, files: string[]) => void,
): BoardWatcher {
  const filesRoot = join(dir, 'files');

  // 内存中的文件集合；用 Set 保证去重，对外返回时排序成数组
  const files = new Set<string>(initial);

  /** 把 chokidar 给出的绝对路径转成规范化的 files/ 相对路径。 */
  function toRelPath(absPath: string): string {
    return normalizePath(relative(filesRoot, absPath).split(sep).join('/'));
  }

  /** 处理一次文件增删，更新内存列表并打印 + 回调。 */
  function handle(type: FileChangeType, absPath: string): void {
    const rel = toRelPath(absPath);
    // 剔除规格 R7 的忽略项（.runtime/、隐藏文件、README.md 等）
    if (!rel || isIgnoredPath(rel)) return;

    if (type === 'add') {
      if (files.has(rel)) return; // 已存在则忽略，避免重复日志
      files.add(rel);
    } else {
      if (!files.has(rel)) return;
      files.delete(rel);
    }

    const snapshot = [...files].sort();
    console.log(`[board-server] 文件${type === 'add' ? '新增' : '删除'}: ${rel}`);
    onChange?.({ type, path: rel }, snapshot);
  }

  // ignoreInitial: true —— 启动时不重放已有文件（初始列表已由 listBoardFiles 提供）
  const watcher: FSWatcher = chokidar.watch(filesRoot, {
    ignoreInitial: true,
    // 隐藏文件 / .runtime 由 isIgnoredPath 兜底，这里不额外配 ignored
  });

  watcher.on('add', (p) => handle('add', p));
  watcher.on('unlink', (p) => handle('unlink', p));
  watcher.on('error', (err) => {
    // 监听层出错不应让进程崩溃，打印即可
    console.error('[board-server] 文件监听出错:', err);
  });

  console.log(`[board-server] 已开始监听 ${filesRoot}`);

  return {
    getFiles: () => [...files].sort(),
    close: () => watcher.close(),
  };
}
