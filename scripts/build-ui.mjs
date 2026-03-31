#!/usr/bin/env node
import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, 'dist', 'public');

await mkdir(out, { recursive: true });

await build({
  entryPoints: [
    path.join(root, 'src', 'public', 'app.ts'),
    path.join(root, 'src', 'public', 'pick.ts'),
  ],
  bundle: true,
  outdir: out,
  platform: 'browser',
  target: 'es2022',
  format: 'esm',
  sourcemap: true,
});

await Promise.all([
  copyFile(path.join(root, 'src', 'public', 'index.html'), path.join(out, 'index.html')),
  copyFile(path.join(root, 'src', 'public', 'styles.css'), path.join(out, 'styles.css')),
  copyFile(path.join(root, 'src', 'public', 'pick.html'), path.join(out, 'pick.html')),
  copyFile(path.join(root, 'src', 'public', 'pick.css'), path.join(out, 'pick.css')),
  copyFile(
    path.join(root, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.mjs'),
    path.join(out, 'pdf.worker.mjs'),
  ),
]);

console.log('build:ui done →', out);
