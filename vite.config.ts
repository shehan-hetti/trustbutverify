import { defineConfig } from 'vite';
import { resolve } from 'path';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default defineConfig({
  plugins: [
    viteStaticCopy({
      targets: [
        {
          src: 'public/manifest.json',
          dest: '.'
        },
        {
          src: 'public/icons/*',
          dest: 'icons'
        }
      ]
    })
  ],
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        'background': resolve(__dirname, 'src/background/service-worker.ts'),
        'content': resolve(__dirname, 'src/content/content-script.ts'),
        'clipboard-bridge': resolve(__dirname, 'src/content/clipboard-bridge.ts'),
        'popup': resolve(__dirname, 'src/popup/popup.html')
      },
      output: {
        entryFileNames: (chunkInfo: any) => {
          if (chunkInfo.name === 'background') {
            return 'background/service-worker.js';
          }
          if (chunkInfo.name === 'content') {
            return 'content/content-script.js';
          }
          if (chunkInfo.name === 'clipboard-bridge') {
            return 'content/clipboard-bridge.js';
          }
          if (chunkInfo.name === 'popup') {
            return 'popup/popup.js';
          }
          return '[name].js';
        },
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: (assetInfo: any) => {
          if (assetInfo.name === 'popup.css') {
            return 'popup/popup.css';
          }
          if (assetInfo.name === 'popup.html') {
            return 'popup/popup.html';
          }
          return 'assets/[name]-[hash][extname]';
        }
      }
    },
    sourcemap: process.env.NODE_ENV === 'development'
  }
});
