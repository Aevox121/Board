import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
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
        target: 'http://127.0.0.1:4500',
        changeOrigin: true,
      },
      // ws 转发：让浏览器只认 4510 上的同源 ws://.../yjs，背后实际连 4500。
      // 多 board 模式下分享链接走同一个 origin 也能 work。
      '/yjs': {
        target: 'ws://127.0.0.1:4500',
        ws: true,
        changeOrigin: true,
      },
    },
  },
}));
