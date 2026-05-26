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
   * 当前画布缩放（LOD 用）—— 屏幕高度 = element.height × zoom 决定渲染档位：
   * - 屏幕高度 < BLUR 阈值：渲染纯模糊占位块（不渲文本、不取文件）
   * - 屏幕高度 < CARD 阈值：渲染卡片态（图标 + 名 + 元信息，不渲 markdown）
   * - 否则：完整 markdown 预览（首次进入时按需 fetch + 自适应高度）
   */
  zoom?: number;
  /**
   * markdown 预览的自适应高度回写 —— ResizeObserver 测得内容高度变化时调用，
   * OverlayLayer 把新高度写回 element.height。不传则不自适应。
   */
  onResize?: (height: number) => void;
}

/**
 * LOD 阈值（按屏幕 px）—— 屏幕高度 < BLUR：模糊占位；< CARD：卡片态；
 * 否则完整预览。零碎手势缩放在 React.memo 里离散化避免抖动切档。
 */
const LOD_BLUR_MAX_PX = 100;
const LOD_CARD_MAX_PX = 240;

/** A4 纸比例（1:√2，长边/短边）—— markdown preview 强制此比例（高=宽×√2）。 */
const A4_RATIO = Math.SQRT2;
/** ov-file__head 实测高度（含 paddings）—— 用于计算 body 可视高度。 */
const HEAD_HEIGHT_PX = 40;
/** ov-file__pager（翻页页脚）实测高度。 */
const PAGER_HEIGHT_PX = 32;

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
  onResize,
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

  /** 已对该 path 发过 fetch（不论成败）—— 避免反复进入 preview LOD 时重抓。
   *  path 变化时 reset effect 会清空它。失败重试 = null。 */
  const fetchedPathRef = useRef<string | null>(null);

  // ── 三档 LOD 解析 ────────────────────────────────────────────
  // displayMode='icon' 永远走 icon（用户显式选）；'card' / 'preview' 受 LOD
  // 影响：屏幕高度过小 → 降级到 blur / card。
  const rawMode = element.displayMode ?? 'preview';
  const screenH = element.height * zoom;
  let mode: 'icon' | 'card' | 'preview' | 'blur';
  if (rawMode === 'icon') mode = 'icon';
  else if (screenH < LOD_BLUR_MAX_PX) mode = 'blur';
  else if (rawMode === 'card' || screenH < LOD_CARD_MAX_PX) mode = 'card';
  else mode = 'preview';

  // ── 按需 fetch：只在 mode='preview' 才真去拉文件 ────────────────
  // 缩到看全局时全部走 blur / card，所有 31 个文件不发请求；放大到某张
  // 进入 preview 档时才触发它的 fetch，自然变成"看哪儿加载哪儿"。
  useEffect(() => {
    if (mode !== 'preview') return;
    if (missing || !previewable || !kind) return;
    if (fetchedPathRef.current === path) return; // 已抓过当前 path
    fetchedPathRef.current = path;
    let cancelled = false;
    void (async () => {
      const text = await fetchFileText(path);
      if (cancelled || !mountedRef.current) return;
      if (text === null) {
        fetchedPathRef.current = null; // 失败允许下次重试
        return;
      }
      setRawText(text);
      applyPreview(text, kind);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, path, mime, previewable, missing, kind]);

  // ── A4 比例强制（仅 preview + 非编辑态）────────────────────────
  // markdown 预览强制纸张比例（height = width × √2）。用户拖宽 → 高度跟着
  // 走；想要不同比例就切到 'card' / 'icon' 模式。偏差超 4px 调 onResize 回写。
  useEffect(() => {
    if (!onResize || editing) return;
    if (mode !== 'preview') return;
    if (!isMarkdownMime(mime)) return; // 仅 md，PDF/图片/csv 不受 A4 约束
    const desired = Math.round(element.width * A4_RATIO);
    if (Math.abs(desired - element.height) > 4) onResize(desired);
  }, [onResize, editing, mode, mime, element.width, element.height]);

  // ── 卡内翻页（markdown 内容超出 body 视窗时分页）────────────────
  // body 固定高度 = card.height - head - pager；inner wrapper 取真实
  // scrollHeight，按 body 高度切分页数。translateY 控制当前页位置。
  const mdBodyRef = useRef<HTMLDivElement | null>(null);
  const mdInnerRef = useRef<HTMLDivElement | null>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  // 测量内容总高度 → 算页数。markdown 渲染完 / 元素宽高变 / 切换文件都触发。
  useEffect(() => {
    if (mode !== 'preview') return;
    if (markdownHtml === null) return;
    const body = mdBodyRef.current;
    const inner = mdInnerRef.current;
    if (!body || !inner) return;
    const measure = (): void => {
      const bodyH = body.clientHeight;
      const contentH = inner.scrollHeight;
      if (bodyH <= 0 || contentH <= 0) return;
      const pages = Math.max(1, Math.ceil(contentH / bodyH));
      setTotalPages((p) => (p === pages ? p : pages));
      // 当前页越界（如内容删短了）→ 回到末页
      setCurrentPage((c) => (c >= pages ? pages - 1 : c));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(body);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [mode, markdownHtml, element.width, element.height]);

  // 文件切换 / 文本变更 → 跳回首页
  useEffect(() => {
    setCurrentPage(0);
  }, [path, rawText]);

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

  // path/mime 变化清空缓存（rawText / 派生预览）。
  // fetch 触发改成按需（见下一个 useEffect）—— 在三档 LOD 中只有 mode='preview'
  // 才真正下文件，缩到看全局时所有 31 个 markdown 都不去发请求。
  useEffect(() => {
    setRawText(null);
    setMarkdownHtml(null);
    setCsvRows(null);
    setTextSnippet(null);
    setImageFailed(false);
    fetchedPathRef.current = null;
  }, [path, mime]);

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

  // mode 已在顶部解析（icon / card / preview / blur 四档，LOD 自动降级）。

  // ── Blur 态：模糊占位块 ────────────────────────────────────
  // 屏幕高度太小，连卡片信息都看不清；连图标都省，直接渲一片"有内容"
  // 的视觉提示。DOM 极简，paint 几乎零成本。
  if (mode === 'blur') {
    return (
      <div
        className="ov-card ov-file ov-file--blur"
        style={cardStyle}
        title={path}
        aria-label={name}
      />
    );
  }

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

  // ── Markdown：A4 纸比例的卡片 + 内容分页 ────────────────────
  if (isMarkdownMime(mime) && markdownHtml !== null) {
    // 翻页：body 固定高度 + inner wrapper translateY 切页。
    const bodyH =
      element.height - HEAD_HEIGHT_PX - (totalPages > 1 ? PAGER_HEIGHT_PX : 0);
    const innerOffset = -currentPage * bodyH;
    const canPrev = currentPage > 0;
    const canNext = currentPage < totalPages - 1;
    return (
      <div className="ov-card ov-file ov-file--md" style={cardStyle} title={path}>
        <div className="ov-file__head">
          <span className="ov-file__glyph" aria-hidden="true">
            {fileGlyph(mime)}
          </span>
          <span className="ov-file__name">{name}</span>
        </div>
        <div
          ref={mdBodyRef}
          className="ov-file__md-body ov-md ov-file__md-body--paged"
          onPointerDown={handleMarkdownBodyPointerDown}
          onClick={handleMarkdownBodyClick}
          style={{ height: bodyH > 0 ? bodyH : undefined }}
        >
          <div
            ref={mdInnerRef}
            className="ov-file__md-inner"
            style={{ transform: `translateY(${innerOffset}px)` }}
            // marked 输出为受信内容来源（本地 .board 文件），M2 直接内联。
            dangerouslySetInnerHTML={{ __html: markdownHtml }}
          />
        </div>
        {totalPages > 1 ? (
          <div
            className="ov-file__pager"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="ov-file__pager-btn"
              disabled={!canPrev}
              onClick={() => setCurrentPage((c) => Math.max(0, c - 1))}
              aria-label="上一页"
              title="上一页"
            >
              ‹
            </button>
            <span className="ov-file__pager-pos">
              {currentPage + 1} / {totalPages}
            </span>
            <button
              type="button"
              className="ov-file__pager-btn"
              disabled={!canNext}
              onClick={() =>
                setCurrentPage((c) => Math.min(totalPages - 1, c + 1))
              }
              aria-label="下一页"
              title="下一页"
            >
              ›
            </button>
          </div>
        ) : null}
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
  if (prev.onResize !== next.onResize) return false;
  // zoom 离散化到 0.05 粒度避免缩放手势抖动反复切档
  const pz = Math.round((prev.zoom ?? 1) * 20);
  const nz = Math.round((next.zoom ?? 1) * 20);
  return pz === nz;
});
