/**
 * Toast 系统 —— 短暂浮于右上角的反馈条（错误 / 警告 / 信息 / 成功），
 * 取代 window.alert。设计规范见 tokens.css。
 *
 * 用法：
 *   import { toast } from './components/toast';
 *   toast.error('保存失败：网络断开');
 *   toast.warn('未连接 board-server');
 *   toast.info('已复制到剪贴板');
 *   toast.success('已保存');
 *
 * 默认 4s 自动消失，可点 ✕ 手动关；同 text+kind 短时间内重复 push 只显示
 * 一条（去重 / counter），避免错误风暴。
 */

export type ToastKind = 'error' | 'warn' | 'info' | 'success';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
  /** 重复出现的累计计数 —— >1 时在文案右侧附「×N」徽标。 */
  count: number;
  /** 入场时间戳，用于动画与排序。 */
  createdAt: number;
}

/** 默认显示时长（毫秒）。 */
const DEFAULT_DURATION_MS = 4000;
/** 去重窗口（毫秒）—— 同 text+kind 在此时间内连发只增计数、不新增条目。 */
const DEDUP_WINDOW_MS = 3000;
/** 同时最多保留多少条；超出按最早进入移除。 */
const MAX_ITEMS = 5;

let nextId = 1;
let items: ToastItem[] = [];
const listeners = new Set<() => void>();
const timers = new Map<number, number>();

function notify(): void {
  for (const l of listeners) l();
}

function scheduleDismiss(id: number, duration: number): void {
  if (timers.has(id)) {
    window.clearTimeout(timers.get(id));
  }
  const handle = window.setTimeout(() => {
    timers.delete(id);
    dismiss(id);
  }, duration);
  timers.set(id, handle);
}

function dismiss(id: number): void {
  const before = items.length;
  items = items.filter((t) => t.id !== id);
  if (timers.has(id)) {
    window.clearTimeout(timers.get(id));
    timers.delete(id);
  }
  if (items.length !== before) notify();
}

function push(kind: ToastKind, text: string, duration: number): number {
  const now = Date.now();
  // 去重：同 text+kind 在 DEDUP_WINDOW_MS 内出现，仅累计计数 + 续期
  const existing = items.find(
    (t) => t.text === text && t.kind === kind && now - t.createdAt < DEDUP_WINDOW_MS,
  );
  if (existing) {
    existing.count += 1;
    existing.createdAt = now; // 续期，避免老的先消失
    scheduleDismiss(existing.id, duration);
    notify();
    return existing.id;
  }
  const id = nextId++;
  items = [...items, { id, kind, text, count: 1, createdAt: now }];
  // 超额：按入场时间最早的移除
  while (items.length > MAX_ITEMS) {
    const drop = items[0]!;
    items = items.slice(1);
    if (timers.has(drop.id)) {
      window.clearTimeout(timers.get(drop.id));
      timers.delete(drop.id);
    }
  }
  scheduleDismiss(id, duration);
  notify();
  return id;
}

/** 全部清空（用于测试 / 调试）。 */
function clear(): void {
  for (const h of timers.values()) window.clearTimeout(h);
  timers.clear();
  items = [];
  notify();
}

/** 订阅条目变化（ToastContainer 用）。返回取消订阅函数。 */
export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 取当前条目快照。 */
export function getToasts(): ToastItem[] {
  return items;
}

export const toast = {
  error: (text: string, duration = DEFAULT_DURATION_MS): number =>
    push('error', text, duration),
  warn: (text: string, duration = DEFAULT_DURATION_MS): number =>
    push('warn', text, duration),
  info: (text: string, duration = DEFAULT_DURATION_MS): number =>
    push('info', text, duration),
  success: (text: string, duration = DEFAULT_DURATION_MS): number =>
    push('success', text, duration),
  dismiss,
  clear,
};
