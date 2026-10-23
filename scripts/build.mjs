import { build } from 'esbuild';
import { mkdir, copyFile, cp } from 'node:fs/promises';
await mkdir('dist/renderer', { recursive: true });
await mkdir('dist/extension', { recursive: true });
await Promise.all([
  build({ entryPoints: ['desktop/main.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: 'dist/desktop/main.cjs', sourcemap: true }),
  build({ entryPoints: ['desktop/preload.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: 'dist/desktop/preload.cjs' }),
  build({ entryPoints: ['renderer/app.ts', 'renderer/capture.ts'], bundle: true, outdir: 'dist/renderer', format: 'iife', target: 'chrome142' }),
  build({ entryPoints: ['extension/background.ts', 'extension/content.ts', 'extension/popup.ts'], bundle: true, outdir: 'dist/extension', format: 'iife', target: 'chrome116' })
]);
for (const f of ['index.html', 'capture.html', 'style.css']) await copyFile(`renderer/${f}`, `dist/renderer/${f}`);
for (const f of ['manifest.json', 'popup.html', 'popup.css']) await copyFile(`extension/${f}`, `dist/extension/${f}`);
await cp('assets', 'dist/assets', { recursive: true });
console.log('Built desktop, renderer, and unpacked extension.');
