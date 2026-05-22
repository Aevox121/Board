/**
 * ID 与命名约定 — 见 specs/数据模型规格.md §11。
 *
 * | 实体 | 前缀 | 格式 |
 * |------|------|------|
 * | 白板 | wb_   | wb_ + 8 hex |
 * | 元素 | el_   | el_ + 12 hex |
 * | 编组 | g_    | g_ + 12 hex |
 * | 快照 | snap_ | snap_ + 4 hex |
 * | 任务 | task_ | task_ + 8 hex |
 */

/** 生成 len 位随机十六进制串（用平台 crypto，Node 19+/现代浏览器均支持）。 */
function randomHex(len: number): string {
  const bytes = new Uint8Array(Math.ceil(len / 2));
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out.slice(0, len);
}

export const newBoardId = (): string => `wb_${randomHex(8)}`;
export const newElementId = (): string => `el_${randomHex(12)}`;
/** 编组 id（画布层选择聚合，见 BaseElement.groupIds）—— 独立命名空间。 */
export const newGroupId = (): string => `g_${randomHex(12)}`;
export const newSnapshotId = (): string => `snap_${randomHex(4)}`;
/** Agent 任务 id（Pencil 式过程可视化，PRD §7.4）—— 独立于元素的命名空间。 */
export const newTaskId = (): string => `task_${randomHex(8)}`;

/** 把名称转为可用于 id 的 slug（保留中文/字母/数字，其余转 `-`）。 */
export function slug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

export const humanId = (name: string): string => `u_${slug(name)}`;
export const agentId = (name: string): string => `a_${slug(name)}`;
