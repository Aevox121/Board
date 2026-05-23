/**
 * 文件监听 — chokidar 监听 `<dir>/files/` 下的真实文件变化。
 *
 * M2 范围：监听 + 维护内存中的文件列表，文件 add/change/unlink 时回调上层，
 * 上层据此触发 reconcile（文件系统 ⇄ 画布同步）。
 */
import { join, relative, sep } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { isIgnoredPath, normalizePath } from '@board/core';

/** 文件变更类型——新增 / 内容变更 / 删除。 */
export type FileChangeType = 'add' | 'change' | 'unlink';

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
  /** 暂停事件分发（chokidar 仍在监听，但不回调 onChange）。
   *  快照复原期间用 —— 整盘换 files/ 时不让 reconcile 拿到中间态。 */
  pause(): void;
  /** 恢复事件分发，并把暂停期间的文件集合状态对齐到磁盘当前实际状态。 */
  resume(currentDiskFiles: string[]): void;
  /** 立即把内存集合同步到磁盘当前状态（不动 paused 状态），用于消除
   *  chokidar 轮询间隔内主动写文件后的 getFiles() 短暂不一致。 */
  sync(currentDiskFiles: string[]): void;
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
  // pause 期间事件不分发（不动 files 集合，避免影响 getFiles 一致性）
  let paused = false;

  /** 把 chokidar 给出的绝对路径转成规范化的 files/ 相对路径。 */
  function toRelPath(absPath: string): string {
    return normalizePath(relative(filesRoot, absPath).split(sep).join('/'));
  }

  /** 各变更类型的中文标签，用于日志。 */
  const LABEL: Record<FileChangeType, string> = {
    add: '新增',
    change: '变更',
    unlink: '删除',
  };

  /** 处理一次文件增删改，更新内存列表并打印 + 回调。 */
  function handle(type: FileChangeType, absPath: string): void {
    if (paused) return; // 复原等批量操作期间静默
    const rel = toRelPath(absPath);
    // 剔除规格 R7 的忽略项（.runtime/、隐藏文件、README.md 等）
    if (!rel || isIgnoredPath(rel)) return;

    if (type === 'add') {
      // 新增：已存在则视为无效重复，直接忽略
      if (files.has(rel)) return;
      files.add(rel);
    } else if (type === 'unlink') {
      // 删除：不在列表里则忽略
      if (!files.has(rel)) return;
      files.delete(rel);
    } else {
      // change：内容变更不改变文件列表，但仍需回调让上层 reconcile
      files.add(rel); // 兜底——理论上 change 前必有 add
    }

    const snapshot = [...files].sort();
    console.log(`[board-server] 文件${LABEL[type]}: ${rel}`);
    onChange?.({ type, path: rel }, snapshot);
  }

  // ignoreInitial: true —— 启动时不重放已有文件（初始列表已由 listBoardFiles 提供）
  // usePolling: true —— 用轮询而非原生 fs.watch。原生监听在 Windows 上会对被
  //   监听的目录树持有句柄，导致服务端 rename / 删除含子目录的区域文件夹失败
  //   （区域嵌套 / 删除）；轮询不持句柄，文件夹整体移动 / 删除即可正常进行。
  const watcher: FSWatcher = chokidar.watch(filesRoot, {
    ignoreInitial: true,
    usePolling: true,
    interval: 250,
    // 隐藏文件 / .runtime 由 isIgnoredPath 兜底，这里不额外配 ignored
  });

  watcher.on('add', (p) => handle('add', p));
  watcher.on('change', (p) => handle('change', p));
  watcher.on('unlink', (p) => handle('unlink', p));
  watcher.on('error', (err) => {
    // 监听层出错不应让进程崩溃，打印即可
    console.error('[board-server] 文件监听出错:', err);
  });

  console.log(`[board-server] 已开始监听 ${filesRoot}`);

  return {
    getFiles: () => [...files].sort(),
    pause: () => { paused = true; },
    resume: (currentDiskFiles: string[]) => {
      // 把内存集合对齐到磁盘当前状态（暂停期间可能整盘换 files/）
      files.clear();
      for (const f of currentDiskFiles) files.add(f);
      paused = false;
    },
    /**
     * 把内存集合直接同步到磁盘当前状态 —— 用于消除 chokidar 轮询间隔
     * 内主动写文件（如 /api/files/upload）与 getFiles() 之间的窗口期不一致。
     * 不动 paused 状态。
     */
    sync: (currentDiskFiles: string[]) => {
      files.clear();
      for (const f of currentDiskFiles) files.add(f);
    },
    close: () => watcher.close(),
  };
}
