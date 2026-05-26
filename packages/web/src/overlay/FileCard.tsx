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
 *
 * 就地编辑（类文本文件）：当父层把 `editing=true` 提上来时，body 替换为
 * textarea，Ctrl+Enter / 失焦提交（writeFileText 覆写磁盘）、Esc 取消。
 * 仅 text/* 系（md / csv / 纯文本）+ 非缺失 + 可预览的文件支持编辑，
 * 是否允许由 `isFileEditable()` 判定，OverlayLayer 据此决定是否触发编辑。
 */
import { memo, useEffect, useRef, useState } from 'react';
import type { FileElement } from '@board/core';
import { fileContentUrl, fetchFileText } from '../server/files';
import { writeFileText } from '../server/client';
import { toast } from '../components/toast';
import { useBoard } from '../board/BoardContext';
import {
  renderMarkdownRich,
  toggleMarkdownTask,
} from '../board/markdownTasks';
import { cardRotation, fileBaseName, formatBytes, parseCsv } from './util';

export interface FileCardProps {
  element: FileElement;
  /** R6：元素 path 指向的文件已不在磁盘上 —— 渲染为「缺失」态。 */
  missing?: boolean;
  /**
   * 就地编辑态（外部控制）—— OverlayLayer 因为 slot 抢占了 pointer capture，
   * 内层 body 的 onDoubleClick 不再可达；改由 slot.onDoubleClick 把
   * `editingId` 提上来，FileCard 据此进入 / 退出编辑态。仅对类文本（text/*）
   * 文件生效，其他 MIME 即便外部传 true 也按预览渲染（编辑入口不开放）。
   */
  editing?: boolean;
  /** 用户按 Esc / 失焦 / Ctrl+Enter 退出编辑时通知调用方清状态。 */
  onEditingChange?: (editing: boolean) => void;
  /**
   * 当前画布缩放（LOD 用）—— 当 zoom × element.height 小于阈值时，回退
   * 到卡片态渲染（避免把不可读的 markdown 全 DOM 化），显著降低多卡场景
   * 的 layout / paint 开销。
   */
  zoom?: number;
}

/**
 * LOD（level of detail）阈值 —— file 元素 displayMode='preview' 且在屏幕
 * 上的高度 < 此值时，渲染降级为卡片态。读者也读不清字，DOM 渲全是浪费。
 */
const LOW_DETAIL_HEIGHT_PX = 200;

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

/**
 * 该 file 元素是否允许就地编辑。
 *
 * 编辑会把整段文本作为 UTF-8 覆写磁盘（writeFileText），仅对：
 *  - text/* 系 MIME（md / csv / 纯文本，含 .json/.html 等若 guessMime 归为 text/*）
 *  - 非缺失（磁盘上有文件）
 *  - 可预览（小文件，未走索引卡片）
 * 三条都满足才放行。OverlayLayer 据此决定是否给 slot 装 dblclick 编辑入口。
 */
export function isFileEditable(
  element: FileElement,
  missing?: boolean,
): boolean {
  if (missing) return false;
  if (element.previewable === false) return false;
  return textKind(element.mime) !== null;
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

function FileCardImpl({
  element,
  missing,
  editing: editingProp,
  onEditingChange,
  zoom = 1,
}: FileCardProps): JSX.Element {
  const { scene, requestNavigateToElement } = useBoard();
  const { path, mime, size, previewable } = element;
  const name = fileBaseName(path);
  const rotation = cardRotation(element.id);
  const kind = textKind(mime);
  const editable = isFileEditable(element, missing);
  const editing = Boolean(editingProp) && editable;

  // 完整原始文本 —— 编辑器的草稿底本，亦驱动 markdown/csv/纯文本的下游预览。
  // null = 尚未拉取 / server 不可达；保存成功后直接更新此值，无需等 reconcile。
  const [rawText, setRawText] = useState<string | null>(null);
  // 文本族预览内容 —— 缓存解析结果（避免每次 render 重跑 marked / parseCsv）。
  // null = 尚未加载 / 不适用 / 加载失败（据此降级为兜底卡片）。
  const [markdownHtml, setMarkdownHtml] = useState<string | null>(null);
  const [csvRows, setCsvRows] = useState<string[][] | null>(null);
  const [textSnippet, setTextSnippet] = useState<string | null>(null);
  // 图片预览是否加载失败 —— 失败时退回兜底卡片。
  const [imageFailed, setImageFailed] = useState(false);
  // 编辑器草稿；进入编辑态时由 rawText 初始化。
  const [draft, setDraft] = useState('');
  // 保存中 —— 提交期间禁用 textarea，按钮转「保存中…」。
  const [saving, setSaving] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // 元素是否仍挂载，避免异步回调写已卸载组件的 state。
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** 把 rawText 投影到对应预览缓存。markdown 路径同时让 GFM 任务列表可勾
   *  + `[[xxx]]` 内链解析。 */
  function applyPreview(text: string, k: 'markdown' | 'csv' | 'plain'): void {
    if (k === 'markdown') {
      setMarkdownHtml(renderMarkdownRich(text, scene.elements));
    } else if (k === 'csv') {
      setCsvRows(parseCsv(text));
    } else {
      setTextSnippet(text.slice(0, TEXT_SNIPPET_LIMIT));
    }
  }

  /** 命中 checkbox / 内链 —— pointerdown 阶段就拦截，否则 slot 会
   *  setPointerCapture 把后续 click 重定向到 slot 上。 */
  function handleMarkdownBodyPointerDown(
    e: React.PointerEvent<HTMLElement>,
  ): void {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    if (t.tagName === 'INPUT' && (t as HTMLInputElement).type === 'checkbox') {
      e.stopPropagation();
      return;
    }
    if (t.tagName === 'A' && t.classList.contains('ov-md-link')) {
      e.stopPropagation();
    }
  }

  /**
   * 委托点击 —— 命中内链跳转；命中 GFM checkbox 翻转任务行并写回。
   * markdown 任务回写：toggleMarkdownTask + writeFileText 覆写磁盘 + 本地
   * rawText/applyPreview 即时刷新（不等 watcher 回波）。失败回滚 + toast。
   */
  function handleMarkdownBodyClick(e: React.MouseEvent<HTMLElement>): void {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    // 内链 [[xxx]] —— 命中即跳画布视口到目标元素
    if (t.tagName === 'A' && t.classList.contains('ov-md-link')) {
      const id = t.dataset['bdLink'];
      if (id) {
        e.preventDefault();
        e.stopPropagation();
        requestNavigateToElement(id);
      }
      return;
    }
    if (!editable) return;
    if (t.tagName !== 'INPUT') return;
    const input = t as HTMLInputElement;
    if (input.type !== 'checkbox') return;
    const raw = input.dataset['taskIndex'];
    if (raw === undefined) return;
    const idx = Number(raw);
    if (!Number.isFinite(idx) || idx < 0) return;
    if (rawText === null) return;
    e.preventDefault();
    e.stopPropagation();
    const next = toggleMarkdownTask(rawText, idx);
    if (next === rawText) return;
    // 乐观即时：本地先刷新 + 异步写盘；失败回滚。
    setRawText(next);
    applyPreview(next, 'markdown');
    void (async () => {
      try {
        await writeFileText(path, next, mime);
      } catch (err) {
        if (!mountedRef.current) return;
        toast.error(
          `保存失败：${err instanceof Error ? err.message : String(err)}`,
        );
        setRawText(rawText);
        applyPreview(rawText, 'markdown');
      }
    })();
  }

  // 文本族文件（md/csv/纯文本）：拉取正文并按类型解析。
  // 缺失 / 大文件 / 非文本族不拉取。
  useEffect(() => {
    setRawText(null);
    setMarkdownHtml(null);
    setCsvRows(null);
    setTextSnippet(null);
    if (missing || !previewable) return;
    if (!kind) return;
    let cancelled = false;
    void (async () => {
      const text = await fetchFileText(path);
      if (cancelled || !mountedRef.current) return;
      if (text === null) return; // server 不可达 / 端点未实现 —— 降级为兜底卡片
      setRawText(text);
      applyPreview(text, kind);
    })();
    return () => {
      cancelled = true;
    };
  }, [path, mime, previewable, missing, kind]);

  // 进入编辑态：拷 rawText（或 ''）为草稿，聚焦并把光标置于末尾。
  useEffect(() => {
    if (!editing) return;
    setDraft(rawText ?? '');
    const ta = taRef.current;
    if (ta) {
      ta.focus();
      // 编辑长文本时全选会糊一片；光标放末尾、不动选区。
      const len = ta.value.length;
      ta.setSelectionRange(len, len);
    }
    // 进入编辑后 rawText 还在异步加载时，加载完了再回填一次草稿。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // 草稿未脏（== rawText）时，rawText 异步到位后同步草稿，避免文本空白。
  useEffect(() => {
    if (!editing) return;
    if (rawText !== null && draft === '') setDraft(rawText);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, rawText]);

  function exitEditing(): void {
    onEditingChange?.(false);
  }

  async function commit(): Promise<void> {
    if (!editable || !kind) {
      exitEditing();
      return;
    }
    // 无变化：直接退出编辑，不打 server。
    if (rawText !== null && draft === rawText) {
      exitEditing();
      return;
    }
    setSaving(true);
    try {
      await writeFileText(path, draft, mime);
      if (!mountedRef.current) return;
      setRawText(draft);
      applyPreview(draft, kind);
      exitEditing();
    } catch (err) {
      toast.error(`保存失败：${err instanceof Error ? err.message : String(err)}`);
      // 失败保留编辑态 + 草稿，便于用户重试或拷走内容。
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }

  function cancel(): void {
    setDraft(rawText ?? '');
    exitEditing();
  }

  // 卡片外层通用属性 —— 手绘质感容器，微旋转由元素 id 派生（稳定不抖）。
  const cardStyle: React.CSSProperties = {
    transform: `rotate(${rotation}deg)`,
  };

  // ── 编辑态（类文本文件）：替换 body 为 textarea ───────────────
  // 优先级最高 —— 即便 markdown/csv 还在拉取，编辑界面立即可见。
  if (editing && kind) {
    return (
      <div
        className="ov-card ov-file ov-file--editing"
        style={cardStyle}
        title={path}
      >
        <div className="ov-file__head">
          <span className="ov-file__glyph" aria-hidden="true">
            {fileGlyph(mime)}
          </span>
          <span className="ov-file__name">{name}</span>
          <span className="ov-file__edit-hint">
            {saving ? '保存中…' : 'Ctrl+Enter 保存 · Esc 取消'}
          </span>
        </div>
        <textarea
          ref={taRef}
          className="ov-file__editor"
          value={draft}
          disabled={saving}
          spellCheck={false}
          // 编辑器内的指针 / 滚轮不应触发卡片拖拽 / 画布缩放。
          onPointerDown={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            void commit();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
            } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void commit();
            }
          }}
        />
      </div>
    );
  }

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

  // 显示模式（PRD §6.4 三种模式手动切换）—— 缺字段时默认 'preview'，保持
  // 与本组件历史观感（"先试预览，不行再卡片态"）一致。'card' = 强制只显
  // 元信息，'icon' = 紧凑图标态。
  // LOD：'preview' 模式但屏幕高度 < 阈值时，强制降级为卡片态。
  const rawMode = element.displayMode ?? 'preview';
  const screenH = element.height * zoom;
  const mode =
    rawMode === 'preview' && screenH < LOW_DETAIL_HEIGHT_PX ? 'card' : rawMode;

  // ── 图标态：紧凑一行 ────────────────────────────────────────
  if (mode === 'icon') {
    return (
      <div
        className="ov-card ov-file ov-file--icon"
        style={cardStyle}
        title={path}
      >
        <span className="ov-file__glyph" aria-hidden="true">
          {fileGlyph(mime)}
        </span>
        <span className="ov-file__name ov-file__name--icon">{name}</span>
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

  // 'card' 模式跳过所有预览分支，直接走兜底卡片（图标 + 文件名 + 元信息）。
  // 'preview' 模式继续往下尝试图片 / PDF / md / csv / 文本预览，任何一个
  // 命中就返回；都不命中再落到底部兜底卡片。
  if (mode === 'preview') {
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
          onPointerDown={handleMarkdownBodyPointerDown}
          onClick={handleMarkdownBodyClick}
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
  } // end mode === 'preview'

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

/**
 * 性能优化：浅比较 props 跳过无关重渲染。
 *
 * 触发重渲染的事件主要是 OverlayLayer 的 viewport / selection / drag 状态
 * 变化 —— 这些都不传到 FileCard，所以 props 不变 → memo 跳过。同时 zoom
 * 离散化到 0.05 粒度后，小范围缩放不会重算 LOD（避免缩放手势抖动反复
 * 切换 preview / card 模式）。
 *
 * scene 变化（任意元素更新）仍会经 useBoard() 内部触发重渲染，memo 无法
 * 拦截 —— 但相比 viewport / selection 高频变化，scene 变化是低频。
 */
export const FileCard = memo(FileCardImpl, (prev, next) => {
  if (prev.element !== next.element) return false;
  if (prev.missing !== next.missing) return false;
  if (prev.editing !== next.editing) return false;
  if (prev.onEditingChange !== next.onEditingChange) return false;
  // zoom 离散化到 0.05 粒度
  const pz = Math.round((prev.zoom ?? 1) * 20);
  const nz = Math.round((next.zoom ?? 1) * 20);
  return pz === nz;
});
