import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig(() => {
  const backendUrl = process.env.VITE_BACKEND_URL ?? 'http://127.0.0.1:8001';
  // uTools 插件从 file:// 加载，需相对资源路径与独立输出目录；
  // 默认保持 "/" 与 dist，不影响现有构建。
  const isUtools = process.env.UTOOLS_BUILD === '1';
  return {
    base: isUtools ? './' : '/',
    build: isUtools ? { outDir: 'dist-utools' } : undefined,
    plugins: [vue(), tailwindcss()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
      proxy: {
        '/api': {
          target: backendUrl,
          changeOrigin: true,
        },
      },
    },
  };
});
