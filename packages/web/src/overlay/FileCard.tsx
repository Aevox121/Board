/**
 * 文件卡片 —— DOM 覆盖层内渲染一个 `file` 元素（PRD §6.4 / 设计系统 §7.4）。
 *
 * 手绘质感卡片（手写体文件名、轻微旋转、暖色表面），按 `displayMode` /
 * `mime` / `previewable` 决定呈现形态：
 *  - 图片（mime 为 image/*）→ 内联预览图，从 `GET /api/files/<path>` 取。
 *  - Markdown（text/markdown）→ 取文本用 `marked` 渲染为 HTML 预览。
 *  - `previewable === false`（大文件）→ 只显示索引卡片（文件名/大小/类型）。
 *  - 其余 → 卡片态（图标 + 文件名 + 元信息）。
 *
 * 本增量只渲染、不做拖拽移动（拖动改文件归属属于下个增量）。
 */
import { useEffect, useRef, useState } from 'react';
import type { FileElement } from '@board/core';
import { marked } from 'marked';
import { fileContentUrl, fetchFileText } from '../server/files';
import { cardRotation, fileBaseName, formatBytes } from './util';

export interface FileCardProps {
  element: FileElement;
}

/** 是否为图片 MIME。 */
function isImageMime(mime: string): boolean {
  return mime.startsWith('image/');
}

/** 是否为 Markdown 文件。 */
function isMarkdownMime(mime: string): boolean {
  return mime === 'text/markdown';
}

/** 按 MIME 大类挑一个简单的字形图标。 */
function fileGlyph(mime: string): string {
  if (isImageMime(mime)) return '🖼';
  if (isMarkdownMime(mime)) return '📝';
  if (mime === 'application/pdf') return '📄';
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

export function FileCard({ element }: FileCardProps): JSX.Element {
  const { path, mime, size, previewable } = element;
  const name = fileBaseName(path);
  const rotation = cardRotation(element.id);

  // Markdown 预览：异步取文件文本并用 marked 渲染。
  // null = 尚未加载 / 不适用；'' 视为已加载但空内容。
  const [markdownHtml, setMarkdownHtml] = useState<string | null>(null);
  // 图片预览是否加载失败 —— 失败时退回索引卡片。
  const [imageFailed, setImageFailed] = useState(false);

  // 元素是否仍挂载，避免异步回调写已卸载组件的 state。
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Markdown 文件：拉取文本并渲染。previewable=false 的大文件不拉取。
  useEffect(() => {
    if (!previewable || !isMarkdownMime(mime)) {
      setMarkdownHtml(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const text = await fetchFileText(path);
      if (cancelled || !mountedRef.current) return;
      if (text === null) {
        // server 不可达 / 端点未实现 —— 退化为索引卡片，不报错。
        setMarkdownHtml(null);
        return;
      }
      // marked.parse 同步返回 string（未启用 async 选项）。
      setMarkdownHtml(marked.parse(text) as string);
    })();
    return () => {
      cancelled = true;
    };
  }, [path, mime, previewable]);

  // 卡片外层通用属性 —— 手绘质感容器，微旋转由元素 id 派生（稳定不抖）。
  const cardStyle: React.CSSProperties = {
    transform: `rotate(${rotation}deg)`,
  };

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
              // server 不可达 / 文件缺失 —— 退回索引卡片，不报错。
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
          className="ov-file__md-body"
          // marked 输出为受信内容来源（本地 .board 文件），M2 直接内联。
          dangerouslySetInnerHTML={{ __html: markdownHtml }}
        />
      </div>
    );
  }

  // ── 兜底：卡片态（图标 + 文件名 + 元信息）────────────────────
  // 也覆盖「图片加载失败」「Markdown 未取到内容」两种降级情形。
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
