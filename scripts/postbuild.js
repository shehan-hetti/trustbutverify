/**
 * postbuild.js
 *
 * Vite outputs multi-page HTML files under dist/src/<page>/<page>.html
 * because input paths are under src/.  We move each HTML to its
 * corresponding dist/<page>/ folder and fix all relative asset paths
 * so they resolve correctly from one level deep (dist/<page>/).
 */

import { readFileSync, writeFileSync, renameSync, rmSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = resolve(__dirname, '..', 'dist');

const pages = ['popup', 'registration'];

for (const page of pages) {
  const srcHtml = resolve(dist, 'src', page, `${page}.html`);
  const destDir = resolve(dist, page);
  const destHtml = resolve(destDir, `${page}.html`);

  if (!existsSync(srcHtml)) {
    console.warn(`[postbuild] ${srcHtml} not found, skipping`);
    continue;
  }

  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true });
  }

  renameSync(srcHtml, destHtml);

  // Fix paths: the HTML was generated at dist/src/<page>/ (2 levels deep)
  // but now lives at dist/<page>/ (1 level deep).
  // - ../../<page>/<file> → ./<file>          (JS/CSS for same page)
  // - ../../chunks/       → ../chunks/        (already fixed by sed, but do it here too)
  let html = readFileSync(destHtml, 'utf-8');

  // Fix self-referencing JS/CSS: ../../<page>/X → ./X
  html = html.replace(
    new RegExp(`(src|href)="../../${page}/`, 'g'),
    '$1="./'
  );

  // Fix chunk references: ../../chunks/ → ../chunks/  (one level up is wrong after move)
  // After moving from dist/src/popup/ to dist/popup/, ../chunks/ is correct
  html = html.replace(/\.\.\/\.\.\/chunks\//g, '../chunks/');

  writeFileSync(destHtml, html, 'utf-8');
  console.log(`[postbuild] ✓ ${page}.html fixed`);
}

// Clean up dist/src/
const srcDir = resolve(dist, 'src');
if (existsSync(srcDir)) {
  rmSync(srcDir, { recursive: true });
  console.log('[postbuild] ✓ dist/src/ removed');
}
