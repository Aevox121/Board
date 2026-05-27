/**
 * 性能诊断开关 —— 默认关闭。控制 PerfHUD 是否挂载、perfLog 是否输出 console。
 *
 * 启用：
 *   localStorage.setItem('board:perf', '1') 然后刷新页面
 * 关闭：
 *   localStorage.removeItem('board:perf') 然后刷新页面
 *
 * 读取一次缓存，避免每帧 localStorage 调用。
 */
function readFlag(): boolean {
  try {
    return localStorage.getItem('board:perf') === '1';
  } catch {
    return false;
  }
}

export const PERF_ENABLED = readFlag();
