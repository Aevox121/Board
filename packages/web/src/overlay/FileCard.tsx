/**
 * 文件卡片 —— DOM 覆盖层内渲染一个 `file` 元素（PRD §6.4 / 设计系统 §7.4）。
 *
 * 手绘质感卡片（手写体文件名、轻微旋转、暖色表面），按 `missing` / `previewable`
 * / `mime` 决定呈现形态：
 *  - `missing`（R6）→ 缺失态卡片：虚线边框 + 警示，不尝试预览，等待恢复或清理。
 *  - `previewable === false`（大文件）→ 只显示索引卡片（文件名/大小/类型）。
 *  - 图片（image/*）→ 内联预览图，从 `GET /api/files/<path>` 取。
 *  - PDF（application/pdf）→ 内嵌 `<embed>` 就地预览首页。
 *  - Markdown（text/markdown）→ 取文本用 `marked` 渲染为 HTML 预览。
 *  - CSV（text/csv）→ 取文本解析为表格预览。
 *  - 其余纯文本（text/*）→ 取文本显示片段预览。
 *  - 兜底 → 卡片态（图标 + 文件名 + 元信息）。
 */
import { useEffect, useRef, useState } from 'react';
import type { FileElement } from '@board/core';
import { marked } from 'marked';
import { fileContentUrl, fetchFileText } from '../server/files';
import { cardRotation, fileBaseName, formatBytes, parseCsv } from './util';

export interface FileCardProps {
  element: FileElement;
  /** R6：元素 path 指向的文件已不在磁盘上 —— 渲染为「缺失」态。 */
  missing?: boolean;
}

/** 纯文本预览截取的字符上限 —— 卡片只需片段。 */
const TEXT_SNIPPET_LIMIT = 800;

/** 是否为图片 MIME。 */
function isImageMime(mime: string): boolean {
  return mime.startsWith('image/');
}

/** 是否为 Markdown 文件。 */
function isMarkdownMime(mime: string): boolean {
  return mime === 'text/markdown';
}

/** 是否为 CSV 文件。 */
function isCsvMime(mime: string): boolean {
  return mime === 'text/csv';
}

/** 是否为 PDF 文件。 */
function isPdfMime(mime: string): boolean {
  return mime === 'application/pdf';
}

/** 文本族预览的细分类型；非文本族返回 null。 */
function textKind(mime: string): 'markdown' | 'csv' | 'plain' | null {
  if (isMarkdownMime(mime)) return 'markdown';
  if (isCsvMime(mime)) return 'csv';
  if (mime.startsWith('text/')) return 'plain';
  return null;
}

/** 按 MIME 大类挑一个简单的字形图标。 */
function fileGlyph(mime: string): string {
  if (isImageMime(mime)) return '🖼';
  if (isMarkdownMime(mime)) return '📝';
  if (isCsvMime(mime)) return '📊';
  if (isPdfMime(mime)) return '📄';
  if (mime === 'application/zip') return '🗜';
  if (mime.startsWith('text/')) return '📃';
  return '📎';
}

/** 取 MIME 的简短可读标签（如 `image/png` → `PNG`）。 */
function mimeLabel(mime: string): string {
  const slash = mime.lastIndexOf('/');
  const tail = slash >= 0 ? mime.slice(slash + 1) : mime;
  return tail.toUpperCase();
}

export function FileCard({ element, missing }: FileCardProps): JSX.Element {
  const { path, mime, size, previewable } = element;
  const name = fileBaseName(path);
  const rotation = cardRotation(element.id);

  // 文本族预览内容；null = 尚未加载 / 不适用 / 加载失败（据此降级为兜底卡片）。
  const [markdownHtml, setMarkdownHtml] = useState<string | null>(null);
  const [csvRows, setCsvRows] = useState<string[][] | null>(null);
  const [textSnippet, setTextSnippet] = useState<string | null>(null);
  // 图片预览是否加载失败 —— 失败时退回兜底卡片。
  const [imageFailed, setImageFailed] = useState(false);

  // 元素是否仍挂载，避免异步回调写已卸载组件的 state。
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 文本族文件（md/csv/纯文本）：拉取正文并按类型解析。
  // 缺失 / 大文件 / 非文本族不拉取。
  useEffect(() => {
    setMarkdownHtml(null);
    setCsvRows(null);
    setTextSnippet(null);
    if (missing || !previewable) return;
    const kind = textKind(mime);
    if (!kind) return;
    let cancelled = false;
    void (async () => {
      const text = await fetchFileText(path);
      if (cancelled || !mountedRef.current) return;
      if (text === null) return; // server 不可达 / 端点未实现 —— 降级为兜底卡片
      if (kind === 'markdown') {
        // marked.parse 同步返回 string（未启用 async 选项）。
        setMarkdownHtml(marked.parse(text) as string);
      } else if (kind === 'csv') {
        setCsvRows(parseCsv(text));
      } else {
        setTextSnippet(text.slice(0, TEXT_SNIPPET_LIMIT));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, mime, previewable, missing]);

  // 卡片外层通用属性 —— 手绘质感容器，微旋转由元素 id 派生（稳定不抖）。
  const cardStyle: React.CSSProperties = {
    transform: `rotate(${rotation}deg)`,
  };

  // ── 缺失态（R6）：文件已不在磁盘上 ───────────────────────────
  if (missing) {
    return (
      <div
        className="ov-card ov-file ov-file--missing"
        style={cardStyle}
        title={`文件缺失：${path}`}
      >
        <div className="ov-file__head">
          <span className="ov-file__glyph" aria-hidden="true">
            ⚠
          </span>
          <span className="ov-file__name">{name}</span>
        </div>
        <div className="ov-file__meta">
          <span className="ov-file__missing-note">文件已不在磁盘上</span>
        </div>
      </div>
    );
  }

  // ── 大文件：只显示索引卡片（不预览、不就地打开）──────────────
  if (!previewable) {
    return (
      <div
        className="ov-card ov-file ov-file--index"
        style={cardStyle}
        title={path}
      >
        <div className="ov-file__head">
          <span className="ov-file__glyph" aria-hidden="true">
            {fileGlyph(mime)}
          </span>
          <span className="ov-file__name">{name}</span>
        </div>
        <div className="ov-file__meta">
          <span>{mimeLabel(mime)}</span>
          <span>·</span>
          <span>{formatBytes(size)}</span>
          <span className="ov-file__badge">大文件</span>
        </div>
      </div>
    );
  }

  // ── 图片：内联预览图 ─────────────────────────────────────────
  if (isImageMime(mime) && !imageFailed) {
    return (
      <div className="ov-card ov-file ov-file--image" style={cardStyle} title={path}>
        <div className="ov-file__image-wrap">
          <img
            className="ov-file__image"
            src={fileContentUrl(path)}
            alt={name}
            draggable={false}
            onError={() => {
              // server 不可达 / 文件缺失 —— 退回兜底卡片，不报错。
              if (mountedRef.current) setImageFailed(true);
            }}
          />
        </div>
        <div className="ov-file__caption">
          <span className="ov-file__name">{name}</span>
        </div>
      </div>
    );
  }

  // ── PDF：内嵌 <embed> 就地预览首页 ───────────────────────────
  if (isPdfMime(mime)) {
    return (
      <div className="ov-card ov-file ov-file--pdf" style={cardStyle} title={path}>
        <div className="ov-file__head">
          <span className="ov-file__glyph" aria-hidden="true">
            {fileGlyph(mime)}
          </span>
          <span className="ov-file__name">{name}</span>
        </div>
        <div className="ov-file__pdf-wrap">
          {/* embed 设 pointer-events:none（见 css）—— 只作预览，不抢卡片拖拽。 */}
          <embed
            className="ov-file__pdf"
            src={`${fileContentUrl(path)}#toolbar=0&navpanes=0&scrollbar=0`}
            type="application/pdf"
          />
        </div>
      </div>
    );
  }

  // ── Markdown：marked 渲染的 HTML 预览 ───────────────────────
  if (isMarkdownMime(mime) && markdownHtml !== null) {
    return (
      <div className="ov-card ov-file ov-file--md" style={cardStyle} title={path}>
        <div className="ov-file__head">
          <span className="ov-file__glyph" aria-hidden="true">
            {fileGlyph(mime)}
          </span>
          <span className="ov-file__name">{name}</span>
        </div>
        <div
          className="ov-file__md-body ov-md"
          // marked 输出为受信内容来源（本地 .board 文件），M2 直接内联。
          dangerouslySetInnerHTML={{ __html: markdownHtml }}
        />
      </div>
    );
  }

  // ── CSV：解析为表格预览 ──────────────────────────────────────
  if (isCsvMime(mime) && csvRows !== null && csvRows.length > 0) {
    const header = csvRows[0] ?? [];
    const body = csvRows.slice(1);
    return (
      <div className="ov-card ov-file ov-file--csv" style={cardStyle} title={path}>
        <div className="ov-file__head">
          <span className="ov-file__glyph" aria-hidden="true">
            {fileGlyph(mime)}
          </span>
          <span className="ov-file__name">{name}</span>
        </div>
        <div className="ov-file__csv-wrap">
          <table className="ov-file__csv">
            <thead>
              <tr>
                {header.map((cell, i) => (
                  <th key={i}>{cell}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((r, ri) => (
                <tr key={ri}>
                  {r.map((cell, ci) => (
                    <td key={ci}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // ── 纯文本：显示内容片段 ─────────────────────────────────────
  if (textKind(mime) === 'plain' && textSnippet !== null) {
    return (
      <div className="ov-card ov-file ov-file--text" style={cardStyle} title={path}>
        <div className="ov-file__head">
          <span className="ov-file__glyph" aria-hidden="true">
            {fileGlyph(mime)}
          </span>
          <span className="ov-file__name">{name}</span>
        </div>
        <pre className="ov-file__text-body">{textSnippet}</pre>
      </div>
    );
  }

  // ── 兜底：卡片态（图标 + 文件名 + 元信息）────────────────────
  // 也覆盖「图片加载失败」「文本未取到内容」等降级情形。
  return (
    <div className="ov-card ov-file ov-file--card" style={cardStyle} title={path}>
      <div className="ov-file__head">
        <span className="ov-file__glyph ov-file__glyph--lg" aria-hidden="true">
          {fileGlyph(mime)}
        </span>
        <span className="ov-file__name">{name}</span>
      </div>
      <div className="ov-file__meta">
        <span>{mimeLabel(mime)}</span>
        <span>·</span>
        <span>{formatBytes(size)}</span>
      </div>
    </div>
  );
}
