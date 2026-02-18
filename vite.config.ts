import { defineConfig } from 'vite';
import { resolve } from 'path';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default defineConfig({
  // Chrome extension popups are loaded from chrome-extension:// — relative paths required
  base: './',
  resolve: {
    alias: {
      // Force the CJS build of text-readability-ts.  The .mjs build has a
      // broken `import pluralize from "pluralize"` that Rollup cannot resolve
      // because pluralize is CJS-only.
      'text-readability-ts': resolve(__dirname, 'node_modules/text-readability-ts/dist/index.js'),
    },
  },
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
    commonjsOptions: {
      include: [/node_modules/],
      transformMixedEsModules: true,
      requireReturnsDefault: 'auto',
    },
    rollupOptions: {
      input: {
        'background': resolve(__dirname, 'src/background/service-worker.ts'),
        'content': resolve(__dirname, 'src/content/content-script.ts'),
        'clipboard-bridge': resolve(__dirname, 'src/content/clipboard-bridge.ts'),
        'popup': resolve(__dirname, 'src/popup/popup.html'),
        'registration': resolve(__dirname, 'src/registration/registration.html')
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
          if (chunkInfo.name === 'registration') {
            return 'registration/registration.js';
          }
          return '[name].js';
        },
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: (assetInfo: any) => {
          if (assetInfo.name === 'popup.css') {
            return 'popup/popup.css';
          }
          if (assetInfo.name === 'registration.css') {
            return 'registration/registration.css';
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
