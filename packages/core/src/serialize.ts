/**
 * board.json / meta.json 的序列化与解析 — 见 specs/数据模型规格.md §2/§3。
 * 纯函数，浏览器与 Node 通用。M1 做轻量校验（schemaVersion + 基本结构）。
 */
import { SCHEMA_VERSION, type BoardMeta, type BoardScene } from './types';

/** 解析白板文件失败时抛出。 */
export class BoardParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoardParseError';
  }
}

export function serializeMeta(meta: BoardMeta): string {
  return JSON.stringify(meta, null, 2);
}

export function serializeScene(scene: BoardScene): string {
  return JSON.stringify(scene, null, 2);
}

function parseJSON(text: string, what: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new BoardParseError(`${what} 不是合法 JSON：${(e as Error).message}`);
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new BoardParseError(`${what} 应为 JSON 对象`);
  }
  return v as Record<string, unknown>;
}

/** 解析 meta.json。 */
export function parseMeta(text: string): BoardMeta {
  const o = parseJSON(text, 'meta.json');
  if (o.schemaVersion !== SCHEMA_VERSION) {
    throw new BoardParseError(
      `meta.json schemaVersion 期望 ${SCHEMA_VERSION}，实际 ${String(o.schemaVersion)}`,
    );
  }
  const m = o as unknown as BoardMeta;
  return {
    ...m,
    participants: m.participants ?? [],
    snapshots: m.snapshots ?? [],
  };
}

/** 解析 board.json。 */
export function parseScene(text: string): BoardScene {
  const o = parseJSON(text, 'board.json');
  if (o.schemaVersion !== SCHEMA_VERSION) {
    throw new BoardParseError(
      `board.json schemaVersion 期望 ${SCHEMA_VERSION}，实际 ${String(o.schemaVersion)}`,
    );
  }
  if (!Array.isArray(o.elements)) {
    throw new BoardParseError('board.json.elements 应为数组');
  }
  const s = o as unknown as BoardScene;
  return {
    schemaVersion: SCHEMA_VERSION,
    viewport: s.viewport ?? { x: 0, y: 0, zoom: 1 },
    elements: s.elements,
  };
}
