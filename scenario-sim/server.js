import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configure } from './src/config.js';
import { setBackend } from './src/store.js';
import { fileBackend } from './src/store-fs.js';
import { handleApi, startAdvance, isAdvanceRoute } from './src/api.js';
import { engineInfo } from './src/engine.js';
import { GEMINI_DEFAULT_MODEL } from './src/gemini.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, 'public');
const PORT = Number(process.env.PORT || 3000);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const anthropicKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || '';
const geminiKey = process.env.GEMINI_API_KEY || '';
// SIM_PROVIDER가 없으면 키가 있는 쪽을 쓴다 (둘 다 있으면 Claude).
const provider = process.env.SIM_PROVIDER || (!anthropicKey && geminiKey ? 'gemini' : 'anthropic');
configure({
  provider,
  apiKey: provider === 'gemini' ? geminiKey : anthropicKey,
  model: process.env.SIM_MODEL || (provider === 'gemini' ? GEMINI_DEFAULT_MODEL : undefined),
  effort: process.env.SIM_EFFORT,
  forceMock: process.env.SIM_MOCK === '1',
});
setBackend(fileBackend(process.env.SIM_DATA_DIR || path.join(process.cwd(), 'data', 'worlds')));

function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function serveStatic(res, pathname) {
  const file = path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'forbidden' });
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

async function advanceStream(req, res, id, input) {
  const run = await startAdvance(id, input);
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const ctrl = new AbortController();
  let cancelled = false;
  // 응답 스트림이 끊기면(브라우저에서 중지) 진행 중인 모델 호출도 취소한다.
  res.on('close', () => {
    if (!res.writableFinished) {
      cancelled = true;
      ctrl.abort();
    }
  });
  await run((ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`), { isCancelled: () => cancelled, signal: ctrl.signal });
  res.end();
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (!pathname.startsWith('/api/')) return await serveStatic(res, pathname);
    const input = req.method === 'GET' ? {} : await body(req);
    if (isAdvanceRoute(req.method, pathname)) return await advanceStream(req, res, pathname.split('/')[3], input);
    const { status, data } = await handleApi(req.method, pathname, input);
    if (pathname.endsWith('/export')) res.setHeader('content-disposition', `attachment; filename="${data.id}.json"`);
    send(res, status, data);
  } catch (e) {
    if (res.headersSent) return res.end();
    const status = e.status || (e instanceof SyntaxError ? 400 : 500);
    if (status >= 500) console.error(e);
    send(res, status, { error: e.message });
  }
});

server.listen(PORT, () => {
  const info = engineInfo();
  console.log(`시나리오 시뮬레이터: http://localhost:${PORT}`);
  console.log(info.mock ? '⚠ 모의 모드 (ANTHROPIC_API_KEY / GEMINI_API_KEY가 없거나 SIM_MOCK=1)' : `${info.provider} 모델: ${info.model}`);
});
