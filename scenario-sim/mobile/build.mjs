// public/ UI와 mobile/entry.js 번들을 mobile/www/로 모은다. Capacitor가 이 폴더를 앱에 넣는다.
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'www');

await fs.rm(out, { recursive: true, force: true });
await fs.cp(path.join(here, '..', 'public'), out, { recursive: true });

await build({
  entryPoints: [path.join(here, 'entry.js')],
  outfile: path.join(out, 'local-api.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome100',
  minify: true,
  logLevel: 'warning',
});

// 일반 스크립트는 모듈(app.js)보다 먼저 실행되므로 app.js가 window.localApi를 바로 볼 수 있다.
const indexFile = path.join(out, 'index.html');
const html = await fs.readFile(indexFile, 'utf8');
await fs.writeFile(indexFile, html.replace('<script type="module" src="/app.js">', '<script src="/local-api.js"></script>\n  <script type="module" src="/app.js">'));
console.log('mobile/www 빌드 완료');
