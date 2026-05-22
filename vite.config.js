import { resolve } from 'path';
import { readFileSync } from 'fs';
import { defineConfig } from 'vite';

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));

// Dev-only: read AGENTPEEK_API_URL from .env.local so /api/* in dev proxies to the real Lambda.
function devApiUrl() {
  try {
    const txt = readFileSync(resolve(__dirname, '.env.local'), 'utf-8');
    const m = txt.match(/^AGENTPEEK_API_URL=(.+)$/m);
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

export default defineConfig({
  root: 'web',
  base: './',
  cacheDir: '../node_modules/.vite',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index:   resolve(__dirname, 'web/index.html'),
        landing: resolve(__dirname, 'web/landing.html'),
        setup:   resolve(__dirname, 'web/setup.html'),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: devApiUrl() ? {
      '/api': { target: devApiUrl(), changeOrigin: true, secure: true },
    } : undefined,
  },
  preview: {
    port: 4173,
    strictPort: true,
    proxy: devApiUrl() ? {
      '/api': { target: devApiUrl(), changeOrigin: true, secure: true },
    } : undefined,
  },
});
