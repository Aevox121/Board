/**
 * 覆盖层共用纯函数 —— 内容元素组件的小工具集。
 */

/**
 * 由元素 id 派生一个稳定的微旋转角度（设计系统 §5.1：±0.6° 随手贴感）。
 *
 * 同一元素旋转值恒定（不随重渲染抖动）。用 id 字符的 charCode 累加做哈希，
 * 映射到 [-0.6, 0.6] 度区间。
 *
 * @param id 元素 id
 * @returns 旋转角度（度）
 */
export function cardRotation(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  // hash % 1201 → [0,1200]，居中后 ÷1000 → [-0.6,0.6]。
  return (((hash % 1201) - 600) / 1000);
}

/**
 * 取相对路径的末段文件名 / 文件夹名。
 *
 * @param path 形如 `路线/day1-route.md` 的相对路径
 * @returns 末段（如 `day1-route.md`）；空路径返回原值。
 */
export function fileBaseName(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/**
 * 把字节数格式化为可读字符串（B / KB / MB / GB）。
 *
 * @param bytes 字节数
 * @returns 如 `1.2 MB`、`840 B`
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx += 1;
  }
  // 小于 10 保留一位小数，否则取整 —— 紧凑且足够精确。
  const text = value < 10 ? value.toFixed(1) : Math.round(value).toString();
  return `${text} ${units[unitIdx]}`;
}
