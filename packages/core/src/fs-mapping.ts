/**
 * 文件系统 ⇄ 画布映射规则 — 见 specs/数据模型规格.md §8（R1–R7）。
 */
import type { Element, RegionElement } from './types';

/** 规范化 files/ 内相对路径：统一用 `/`、去首尾斜杠。 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

/** childPath 是否位于 parentDir 之内（含多层嵌套）。 */
export function isInside(parentDir: string, childPath: string): boolean {
  const parent = normalizePath(parentDir);
  const child = normalizePath(childPath);
  if (parent === '') return true;
  return child === parent || child.startsWith(parent + '/');
}

/** 收集场景内所有 region 元素。 */
export function regionsOf(elements: Element[]): RegionElement[] {
  return elements.filter((e): e is RegionElement => e.type === 'region');
}

/**
 * R1/R3：文件应归属的区域——其路径的最深祖先目录对应的 region。
 * 无匹配时返回 null（=> 落入收件区）。
 */
export function regionForFile(
  filePath: string,
  regions: RegionElement[],
): RegionElement | null {
  const file = normalizePath(filePath);
  let best: RegionElement | null = null;
  let bestLen = -1;
  for (const r of regions) {
    const rp = normalizePath(r.path);
    if (rp === '' || file === rp) continue;
    if (isInside(rp, file) && rp.length > bestLen) {
      best = r;
      bestLen = rp.length;
    }
  }
  return best;
}

/** R7：是否为应忽略、不生成独立文件元素的路径。 */
export function isIgnoredPath(p: string): boolean {
  const n = normalizePath(p);
  if (n === '') return true;
  if (n.startsWith('.runtime/')) return true;
  if (n.split('/').some((seg) => seg.startsWith('.'))) return true;
  // README.md 是区域描述载体，不单独成文件元素
  return n === 'README.md' || n.endsWith('/README.md');
}

/**
 * R6：元素引用的文件是否缺失。
 * @param existingFiles files/ 下现存文件的规范化路径集合
 */
export function isMissing(el: Element, existingFiles: Set<string>): boolean {
  if (el.type !== 'file') return false;
  return !existingFiles.has(normalizePath(el.path));
}
