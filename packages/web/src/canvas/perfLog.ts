/**
 * 操作级 perf 日志 —— 关键路径每次执行都 record(name, ms)，每秒 console.table
 * 一次汇总（次数 / 平均 / 最大 / 总耗时）。低频事件用 once() 直接打 log。
 *
 * 用来定位"卡顿"具体卡在哪一步：是 React render / snap 计算 / DOM mutate /
 * 还是别的代码。
 *
 * 默认关闭。启用：`localStorage.setItem('board:perf', '1')` + 刷新页面。
 * 关闭后 record() / once() 都早退，性能影响为零。
 */
import { PERF_ENABLED } from './perfFlag';

interface Stat {
  count: number;
  totalMs: number;
  maxMs: number;
}

const high = new Map<string, Stat>();
let lastFlush = performance.now();

/** 高频路径打点 —— 累积，每秒 flush。ms 可省（只计数，不测时）。
 *  默认关闭（PERF_ENABLED=false），早退；启用后才记录 + 周期 console.table。 */
export function record(name: string, ms?: number): void {
  if (!PERF_ENABLED) return;
  const v = ms ?? 0;
  const cur = high.get(name);
  if (!cur) {
    high.set(name, { count: 1, totalMs: v, maxMs: v });
  } else {
    cur.count += 1;
    cur.totalMs += v;
    if (v > cur.maxMs) cur.maxMs = v;
  }
  const now = performance.now();
  if (now - lastFlush >= 1000) flush(now);
}

/** 低频事件 —— 直接 console.log。默认关闭。 */
export function once(name: string, ms?: number, detail?: unknown): void {
  if (!PERF_ENABLED) return;
  if (ms !== undefined) {
    console.log(`[perf] ${name}: ${ms.toFixed(2)}ms`, detail ?? '');
  } else {
    console.log(`[perf] ${name}`, detail ?? '');
  }
}

/** 包装函数 —— 测它的同步耗时，返回值原样透传。 */
export function timed<T>(name: string, fn: () => T): T {
  if (!PERF_ENABLED) return fn();
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    record(name, performance.now() - t0);
  }
}

function flush(now: number): void {
  if (high.size === 0) {
    lastFlush = now;
    return;
  }
  const rows: Array<{
    name: string;
    count: number;
    avgMs: number;
    maxMs: number;
    totalMs: number;
  }> = [];
  for (const [name, stat] of high) {
    rows.push({
      name,
      count: stat.count,
      avgMs: Number((stat.totalMs / stat.count).toFixed(2)),
      maxMs: Number(stat.maxMs.toFixed(2)),
      totalMs: Number(stat.totalMs.toFixed(1)),
    });
  }
  rows.sort((a, b) => b.totalMs - a.totalMs);
  // eslint-disable-next-line no-console
  console.table(rows);
  high.clear();
  lastFlush = now;
}
