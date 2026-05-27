/**
 * 性能诊断专用 —— 组件级渲染计数器。
 *
 * 用法：在需要观察重渲频率的组件函数体顶部调 `renderCounters.bump('Name')`。
 * `PerfHUD` 每 500ms 采样一次然后清零，显示成"X 次/s"。
 *
 * 仅作诊断；体感问题排查完后可全部移除。
 */
export const renderCounters = {
  current: {} as Record<string, number>,
  bump(key: string): void {
    this.current[key] = (this.current[key] ?? 0) + 1;
  },
  snapshotAndReset(): Record<string, number> {
    const snap = this.current;
    this.current = {};
    return snap;
  },
};
