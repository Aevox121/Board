/**
 * Node 端 .board 文件夹读写 — 见 specs/数据模型规格.md §5.2。
 *
 * ⚠️ 本模块含 node:fs，仅供 @board/server / @board/cli 使用；
 *    浏览器侧请只引入 `@board/core`（不含本模块）。
 */
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { BoardMeta, BoardScene } from '../types';
import { createBoardMeta, createBoardScene } from '../factory';
import {
  serializeMeta,
  serializeScene,
  parseMeta,
  parseScene,
} from '../serialize';
import { isIgnoredPath, normalizePath } from '../fs-mapping';

const META_FILE = 'meta.json';
const BOARD_FILE = 'board.json';

/** 一个已加载的白板。 */
export interface BoardHandle {
  /** .board 目录绝对路径 */
  dir: string;
  meta: BoardMeta;
  scene: BoardScene;
}

/**
 * 在 parentDir 下新建 `<name>.board` 文件夹，写入初始 meta/board 与子目录。
 * @returns 新建的 .board 目录路径
 */
export async function createBoardFolder(
  parentDir: string,
  name: string,
): Promise<string> {
  const dir = join(parentDir, `${name}.board`);
  await mkdir(join(dir, 'files'), { recursive: true });
  await mkdir(join(dir, 'assets'), { recursive: true });
  await mkdir(join(dir, 'history', 'snapshots'), { recursive: true });
  const meta = createBoardMeta({ name });
  const scene = createBoardScene();
  await writeFile(join(dir, META_FILE), serializeMeta(meta), 'utf8');
  await writeFile(join(dir, BOARD_FILE), serializeScene(scene), 'utf8');
  return dir;
}

/** 读取一个 .board 文件夹。 */
export async function loadBoard(dir: string): Promise<BoardHandle> {
  const meta = parseMeta(await readFile(join(dir, META_FILE), 'utf8'));
  const scene = parseScene(await readFile(join(dir, BOARD_FILE), 'utf8'));
  return { dir, meta, scene };
}

/** 保存 meta + scene 到 .board 文件夹（自动更新 meta.updatedAt）。 */
export async function saveBoard(
  dir: string,
  meta: BoardMeta,
  scene: BoardScene,
): Promise<void> {
  const updated: BoardMeta = { ...meta, updatedAt: new Date().toISOString() };
  await writeFile(join(dir, META_FILE), serializeMeta(updated), 'utf8');
  await writeFile(join(dir, BOARD_FILE), serializeScene(scene), 'utf8');
}

/**
 * 递归扫描 .board/files/ 下的文件，返回规范化相对路径数组。
 * 剔除规格 R7 定义的忽略项。
 */
export async function listBoardFiles(dir: string): Promise<string[]> {
  const root = join(dir, 'files');
  const out: string[] = [];

  async function walk(d: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return; // files/ 不存在则视为空
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else {
        const rel = normalizePath(relative(root, full).split(sep).join('/'));
        if (!isIgnoredPath(rel)) out.push(rel);
      }
    }
  }

  await walk(root);
  return out.sort();
}
