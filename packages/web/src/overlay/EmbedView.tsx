/**
 * 外链嵌入渲染 —— 把一个 `embed` 元素渲染为链接卡或 iframe（数据模型 §6.10）。
 *
 *  - `link-card`：紧凑卡片，显示站点域名 + 完整 URL + 「在新标签打开」入口。
 *    不抓取站点标题 / og 信息（需后端代理，超出范围）。
 *  - `iframe`：直接内嵌目标页。iframe 设 `pointer-events:none` —— 整个嵌入
 *    元素仍可被拖拽 / 选中，iframe 内容此阶段为只读预览（不可交互）。
 */
import type { EmbedElement } from '@board/core';

/** 取 URL 的主机名（去掉 www. 前缀）；解析失败则回退原串。 */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function EmbedView({ element }: { element: EmbedElement }): JSX.Element {
  const { url, embedType } = element;

  if (embedType === 'iframe') {
    // 可交互态（PRD §6.10）—— iframe 取消 pointer-events:none，用户可在
    // 内部点击 / 滚动 / 输入；trade-off:拖拽该 embed 必须从外框入手。
    const interactive = element.interactive === true;
    return (
      <div className="ov-embed ov-embed--frame">
        <iframe
          className={
            'ov-embed__iframe' +
            (interactive ? ' ov-embed__iframe--interactive' : '')
          }
          src={url}
          title={url}
          sandbox="allow-scripts allow-same-origin allow-popups"
          loading="lazy"
        />
      </div>
    );
  }

  return (
    <div className="ov-embed ov-embed--card">
      <div className="ov-embed__icon" aria-hidden="true">
        🔗
      </div>
      <div className="ov-embed__body">
        <div className="ov-embed__host">{hostOf(url)}</div>
        <div className="ov-embed__url">{url}</div>
      </div>
      <a
        className="ov-embed__open"
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title="在新标签打开"
        // 打开入口的指针操作不冒泡到卡槽 —— 不触发拖拽 / 重选。
        onPointerDown={(e) => e.stopPropagation()}
      >
        ↗
      </a>
    </div>
  );
}
