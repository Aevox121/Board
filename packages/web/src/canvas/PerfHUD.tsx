/**
 * 性能 HUD —— 屏幕右上角实时显示 FPS、平均帧时、各组件重渲频率。
 *
 * 这是一个诊断面板，用于定位"卡顿"到底是真 FPS 下降还是别的（视觉不同步、
 * 输入延迟等）。挂在 CanvasShell 的右上角，pointer-events:none 不挡操作。
 *
 * 测量方式：
 *  - 自循环 requestAnimationFrame，记录每帧时间戳；每 500ms 算一次 FPS / 帧时。
 *  - 组件重渲计数走 `renderCounters`（各组件函数体顶部 bump），HUD 周期采样。
 */
import { useEffect, useState } from 'react';
import { renderCounters } from './renderCounters';

interface Metrics {
  fps: number;
  frameMs: number;
  counters: Record<string, number>;
}

const SAMPLE_INTERVAL_MS = 500;

export function PerfHUD(): JSX.Element {
  const [metrics, setMetrics] = useState<Metrics>({
    fps: 0,
    frameMs: 0,
    counters: {},
  });

  useEffect(() => {
    let rafId = 0;
    let lastTime = performance.now();
    let frames = 0;
    let totalMs = 0;
    let windowStart = lastTime;

    const tick = (now: number): void => {
      const dt = now - lastTime;
      lastTime = now;
      totalMs += dt;
      frames += 1;
      const elapsed = now - windowStart;
      if (elapsed >= SAMPLE_INTERVAL_MS) {
        setMetrics({
          fps: Math.round((frames * 1000) / elapsed),
          frameMs: parseFloat((totalMs / Math.max(1, frames)).toFixed(1)),
          counters: renderCounters.snapshotAndReset(),
        });
        frames = 0;
        totalMs = 0;
        windowStart = now;
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const fpsColor =
    metrics.fps >= 55
      ? '#7fff7f'
      : metrics.fps >= 30
        ? '#ffe066'
        : '#ff6b6b';

  return (
    <div
      style={{
        position: 'fixed',
        top: 8,
        right: 8,
        zIndex: 99999,
        background: 'rgba(0, 0, 0, 0.78)',
        color: '#fff',
        padding: '8px 12px',
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 11,
        lineHeight: '14px',
        pointerEvents: 'none',
        borderRadius: 6,
        boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
        minWidth: 130,
      }}
    >
      <div style={{ color: fpsColor, fontSize: 13, fontWeight: 600 }}>
        FPS: {metrics.fps}
      </div>
      <div>frame: {metrics.frameMs} ms</div>
      <div
        style={{
          borderTop: '1px solid rgba(255,255,255,0.2)',
          marginTop: 4,
          paddingTop: 4,
          color: '#bbb',
        }}
      >
        renders / 0.5s:
      </div>
      {Object.entries(metrics.counters)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => (
          <div key={k} style={{ color: v > 30 ? '#ffd166' : '#dde' }}>
            {k}: {v}
          </div>
        ))}
    </div>
  );
}
