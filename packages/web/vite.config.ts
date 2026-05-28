import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * board-server 端口 —— 默认 4500，可经 BOARD_API_PORT 环境变量覆盖。
 * 多实例并行调试时（如同时跑两套 server/vite 看不同 board）用得上。
 */
const BOARD_API_PORT = process.env.BOARD_API_PORT ?? '4500';

/**
 * 给 vite dev server 的所有 TCP 连接关掉 Nagle 算法（TCP_NODELAY）。
 *
 * 局域网他人经 vite 的 `/yjs` ws proxy 协作时，Y.Doc 增量帧都很小；Nagle 会把
 * 小帧攒到下个 ACK 才发，叠加延迟 ACK 可造成几十~上百 ms 的「等一段才刷新」。
 * 这条 client↔vite（WiFi）腿的 socket 由 vite 的 httpServer 持有，故在此统一
 * setNoDelay。ws 升级走的也是同一批连接（upgrade 前先触发 connection 事件），
 * 一并覆盖。本机直连 4500 不经此 proxy，故之前感觉本地快、远端慢。
 */
function tcpNoDelay(): PluginOption {
  return {
    name: 'board-tcp-no-delay',
    configureServer(server) {
      server.httpServer?.on('connection', (socket) => {
        socket.setNoDelay(true);
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tcpNoDelay()],
  // Excalidraw 的入口 main.js 在运行时读 process.env.*，而浏览器没有 process。
  // 用 define 在构建期把它们替换为字面量，避免 "process is not defined" 崩溃。
  define: {
    'process.env.IS_PREACT': JSON.stringify('false'),
    'process.env.NODE_ENV': JSON.stringify(mode),
  },
  server: {
    host: '127.0.0.1',
    port: 4510,
    // 把 /api/* 转发到本地 board-server，避开浏览器跨域（CORS）限制。
    // server 未启动时代理会失败，由前端 client 层捕获并降级到离线模式。
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${BOARD_API_PORT}`,
        changeOrigin: true,
      },
      // ws 转发：让浏览器只认 vite 同源 ws://.../yjs，背后实际连 board-server。
      // 多 board 模式下分享链接走同一个 origin 也能 work。
      '/yjs': {
        target: `ws://127.0.0.1:${BOARD_API_PORT}`,
        ws: true,
        changeOrigin: true,
      },
    },
  },
}));
