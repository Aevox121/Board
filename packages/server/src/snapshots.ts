/**
 * 存档点（snapshot）实现 —— PRD §8.5「冲突处理与撤回/复原」之「存档点
 * + 一键复原」机制。日常小回退用 undo/redo（已在 BoardContext），大范围
 * 找回 / Agent 大改前后用此处的快照。
 *
 * 磁盘布局：
 *   <dir>/history/snapshots/<snap_id>/
 *     ├── board.json
 *     ├── meta.json
 *     └── files/          （完整副本，含子目录）
 *
 * 索引：在 meta.snapshots[] 维护一份 SnapshotIndexEntry 列表，包含 id /
 * name / createdBy / createdAt / auto。两面（meta 索引 + 实际目录）以
 * meta 索引为准（缺目录算无效快照）。
 *
 * 复原 = 先把当前状态自动建一档（防误操作），再把快照内容覆盖回当前
 * board.json / meta.json / files/，最后由调用方触发 Y.Doc 重载与广播。
 */
import { randomBytes } from 'node:crypto';
import {
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  parseMeta,
  parseScene,
  serializeMeta,
  serializeScene,
  type BoardMeta,
  type BoardScene,
  type ParticipantId,
  type SnapshotIndexEntry,
} from '@board/core';
import { listBoardFiles } from '@board/core/node';

/** 新快照 id（`snap_` + 4 位十六进制，与 PRD §6.9 对齐）。 */
function newSnapshotId(): string {
  return 'snap_' + randomBytes(2).toString('hex');
}

/** 把 meta 写盘，序列化校验失败时抛 `Error`（serializeMeta 已返字符串）。 */
async function writeMeta(dir: string, meta: BoardMeta): Promise<void> {
  await writeFile(join(dir, 'meta.json'), serializeMeta(meta), 'utf8');
}

/** 读盘 meta（校验通过；parseMeta 自带 JSON 解析）。 */
async function readBoardMeta(dir: string): Promise<BoardMeta> {
  return parseMeta(await readFile(join(dir, 'meta.json'), 'utf8'));
}

/** 读盘 scene（校验通过；parseScene 自带 JSON 解析）。 */
async function readBoardScene(dir: string): Promise<BoardScene> {
  return parseScene(await readFile(join(dir, 'board.json'), 'utf8'));
}

export interface CreateSnapshotResult {
  entry: SnapshotIndexEntry;
  /** 落地后的 meta（snapshots[] 已新增本条）。 */
  meta: BoardMeta;
}

/**
 * 建一份快照 —— 把当前 board.json + meta.json + files/ 完整复制到
 * history/snapshots/<id>/，并把索引追加进 meta.snapshots。
 *
 * @param dir       .board 目录绝对路径
 * @param name      用户起的名字（auto 快照可空，会自动取「自动 · ts」）
 * @param actor     操作者 id
 * @param auto      true = 自动快照（高风险操作前 / 复原前），false = 手动
 */
export async function createSnapshot(opts: {
  dir: string;
  name: string | null;
  actor: ParticipantId;
  auto: boolean;
}): Promise<CreateSnapshotResult> {
  const { dir, actor, auto } = opts;
  const meta = await readBoardMeta(dir);
  const id = newSnapshotId();
  const ts = new Date().toISOString();
  const finalName =
    opts.name && opts.name.trim()
      ? opts.name.trim()
      : auto
        ? `自动 · ${ts.slice(11, 19)}`
        : `存档 · ${ts.slice(11, 19)}`;

  const snapDir = resolve(dir, 'history', 'snapshots', id);
  await mkdir(snapDir, { recursive: true });

  // 复制 board.json / meta.json —— 直接读写，保证序列化校验过
  await cp(join(dir, 'board.json'), join(snapDir, 'board.json'));
  await cp(join(dir, 'meta.json'), join(snapDir, 'meta.json'));

  // 复制 files/（递归；不存在时建空目录占位）
  const filesSrc = join(dir, 'files');
  const filesDst = join(snapDir, 'files');
  try {
    await stat(filesSrc);
    await cp(filesSrc, filesDst, { recursive: true });
  } catch {
    await mkdir(filesDst, { recursive: true });
  }

  const entry: SnapshotIndexEntry = {
    id,
    name: finalName,
    createdBy: actor,
    createdAt: ts,
    auto,
    opSeq: 0, // 当前未维护 op 序号，留 0；后续按需挂上
  };
  const nextMeta: BoardMeta = {
    ...meta,
    snapshots: [...meta.snapshots, entry],
    updatedAt: ts,
  };
  await writeMeta(dir, nextMeta);
  return { entry, meta: nextMeta };
}

/** 列出当前所有存档点（从 meta 读，避免每次扫盘）。 */
export async function listSnapshots(dir: string): Promise<SnapshotIndexEntry[]> {
  const meta = await readBoardMeta(dir);
  return [...meta.snapshots];
}

/** 删除一个存档点（移除目录 + meta 索引）。返回删除结果与新 meta。 */
export async function deleteSnapshot(opts: {
  dir: string;
  snapshotId: string;
}): Promise<{ removed: boolean; meta: BoardMeta }> {
  const { dir, snapshotId } = opts;
  const meta = await readBoardMeta(dir);
  const idx = meta.snapshots.findIndex((s) => s.id === snapshotId);
  if (idx < 0) return { removed: false, meta };
  const snapDir = resolve(dir, 'history', 'snapshots', snapshotId);
  try {
    await rm(snapDir, { recursive: true, force: true });
  } catch (err) {
    if (
      err instanceof Error &&
      'code' in err &&
      (err as NodeJS.ErrnoException).code !== 'ENOENT'
    ) {
      throw err;
    }
  }
  const nextMeta: BoardMeta = {
    ...meta,
    snapshots: meta.snapshots.filter((s) => s.id !== snapshotId),
    updatedAt: new Date().toISOString(),
  };
  await writeMeta(dir, nextMeta);
  return { removed: true, meta: nextMeta };
}

export interface RestoreSnapshotResult {
  /** 复原前自动建的存档（id）。 */
  preRestoreSnapshotId: string;
  /** 复原后的 scene 与 meta —— 调用方据此重置 Y.Doc + 广播。 */
  scene: BoardScene;
  meta: BoardMeta;
  /** 复原后磁盘上的实际文件列表（供 watcher.resume 对齐）。 */
  files: string[];
}

/**
 * 复原到一个存档点。
 *
 * 流程：
 *  1. 自动建一份 pre-restore 快照（auto=true），防误操作丢失当前状态。
 *  2. 把 history/snapshots/<id>/files/ 整盘换回 current files/（旧 files/
 *     先移到 .runtime/trash/<ts>-pre-restore/ 兜底）。
 *  3. 把 snapshot 的 board.json / meta.json 覆盖回当前；meta.snapshots
 *     合并：保留快照里的 + 加上 pre-restore 一条 + 加上当前所有快照里
 *     在 snapshot 之后的（避免复原把后续档案抹掉）。
 *  4. 调用方读返回值更新 Y.Doc + 广播 board-changed。
 *
 * **必须由调用方在执行前 watcher.pause()，执行后 watcher.resume(files)。**
 */
export async function restoreSnapshot(opts: {
  dir: string;
  snapshotId: string;
  actor: ParticipantId;
}): Promise<RestoreSnapshotResult> {
  const { dir, snapshotId, actor } = opts;
  const snapDir = resolve(dir, 'history', 'snapshots', snapshotId);

  // 1) 校验快照存在
  let snapMeta: BoardMeta;
  let snapScene: BoardScene;
  try {
    snapMeta = await readBoardMeta(snapDir);
    snapScene = await readBoardScene(snapDir);
  } catch (err) {
    throw new Error(
      `读取快照失败 (${snapshotId}): ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  // 2) 当前状态先自动建一档
  const pre = await createSnapshot({
    dir,
    name: `复原前自动存档`,
    actor,
    auto: true,
  });

  // 3) files/ 整盘换：旧 → 回收站；snapshot/files/ → 当前 files/
  const currentFiles = resolve(dir, 'files');
  const trashRoot = resolve(dir, '.runtime', 'trash');
  await mkdir(trashRoot, { recursive: true });
  const trashDir = resolve(
    trashRoot,
    `${Date.now()}-pre-restore-${snapshotId}`,
  );
  // 旧 files/ 移入回收站；不存在则跳过
  try {
    await stat(currentFiles);
    try {
      await rename(currentFiles, trashDir);
    } catch {
      // Windows 句柄占用兜底：cp + rm
      await cp(currentFiles, trashDir, { recursive: true });
      await rm(currentFiles, { recursive: true, force: true });
    }
  } catch {
    /* 不存在，跳过 */
  }
  // snapshot/files/ → current files/
  const snapFilesSrc = join(snapDir, 'files');
  try {
    await stat(snapFilesSrc);
    await cp(snapFilesSrc, currentFiles, { recursive: true });
  } catch {
    await mkdir(currentFiles, { recursive: true });
  }

  // 4) 合并 meta：快照 meta 是底；加上 pre-restore 的索引条目；再合并
  //    pre-restore 之前当前 meta 里就已有、但快照里没有的存档（不丢档案）。
  const nowMeta = pre.meta; // pre 落盘已含原索引 + pre-restore 一条
  const snapIds = new Set(snapMeta.snapshots.map((s) => s.id));
  const additionalAfterSnap = nowMeta.snapshots.filter(
    (s) => !snapIds.has(s.id),
  );
  const mergedMeta: BoardMeta = {
    ...snapMeta,
    snapshots: [...snapMeta.snapshots, ...additionalAfterSnap],
    updatedAt: new Date().toISOString(),
  };
  await writeMeta(dir, mergedMeta);

  // 5) board.json 覆盖（serializeScene 已返字符串）
  await writeFile(join(dir, 'board.json'), serializeScene(snapScene), 'utf8');

  // 6) 给调用方返回新场景 / meta / 文件列表
  const diskFiles = await listBoardFiles(dir);

  // 引用 dirname 防 TS 报未用警告（保留 future 使用）
  void dirname;

  return {
    preRestoreSnapshotId: pre.entry.id,
    scene: snapScene,
    meta: mergedMeta,
    files: diskFiles,
  };
}
