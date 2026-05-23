/**
 * Toast 容器 —— 渲染右上角的 toast 列表，订阅 toast.ts 的外部 store。
 *
 * 设计规范见 tokens.css：白卡片 + 类型色左侧条 + 类型色图标，遮罩外浮层
 * （不阻断画布交互）。
 */
import { useSyncExternalStore } from 'react';
import { getToasts, subscribeToasts, toast, type ToastItem } from './toast';
import './ToastContainer.css';

const ICON: Record<ToastItem['kind'], string> = {
  error: '✕',
  warn: '!',
  info: 'i',
  success: '✓',
};

function ToastView({ item }: { item: ToastItem }): JSX.Element {
  return (
    <div className={`bd-toast bd-toast--${item.kind}`} role="status">
      <span className="bd-toast__icon" aria-hidden="true">
        {ICON[item.kind]}
      </span>
      <span className="bd-toast__text">{item.text}</span>
      {item.count > 1 && (
        <span className="bd-toast__count" aria-label={`重复 ${item.count} 次`}>
          ×{item.count}
        </span>
      )}
      <button
        type="button"
        className="bd-toast__close"
        onClick={() => toast.dismiss(item.id)}
        aria-label="关闭"
      >
        ✕
      </button>
    </div>
  );
}

export function ToastContainer(): JSX.Element | null {
  const items = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  if (items.length === 0) return null;
  return (
    <div className="bd-toast-stack">
      {items.map((t) => (
        <ToastView key={t.id} item={t} />
      ))}
    </div>
  );
}
