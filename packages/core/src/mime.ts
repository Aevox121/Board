/**
 * 按扩展名猜测 MIME 类型 — 供 reconcile / 文件元素使用。
 */

const MIME_BY_EXT: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  bmp: 'image/bmp',
  pdf: 'application/pdf',
  csv: 'text/csv',
  zip: 'application/zip',
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  ts: 'text/typescript',
};

/** 根据路径扩展名返回 MIME 类型，未知则 `application/octet-stream`。 */
export function guessMime(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  const ext = path.slice(dot + 1).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/** 该 MIME 是否为图片。 */
export function isImageMime(mime: string): boolean {
  return mime.startsWith('image/');
}
