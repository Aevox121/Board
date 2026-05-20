import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
    },
  },
});
