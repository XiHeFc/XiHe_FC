import { defineConfig } from 'vite';

/**
 * 只给「内核」用的构建。
 *
 * 为什么是 iife 而不是 esm：产品承诺过双击 index.html 就能跑，
 * ESM 在 file:// 下会被 CORS 拦掉。iife 产物是普通脚本，
 * 双击、静态服务、Electron 三种场景行为完全一致。
 *
 * 老代码（assets/js/*.js）不经过这里的构建，保持原样加载 —— 这是回滚点。
 */
export default defineConfig({
  build: {
    lib: {
      entry: 'src/core/index.ts',
      name: 'XHGCS_CORE_BUNDLE',
      formats: ['iife'],
      fileName: () => 'core.bundle.js'
    },
    outDir: 'assets/js',
    emptyOutDir: false,
    target: 'es2020',
    minify: false,
    reportCompressedSize: false,
    sourcemap: false,
    rollupOptions: {
      output: {
        extend: true,
        inlineDynamicImports: true
      }
    }
  }
});
