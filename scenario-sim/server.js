import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './src/store.js';
import * as engine from './src/engine.js';
import { createWorld, normalizeCharacter, normalizeSetting, addCharacter, upsertRelationship, addIntervention, findRelationship } from './src/world.js';
import { isValidDate, compareDates } from './src/dates.js';
import { SAMPLE_WORLD } from './src/sample.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, 'public');
const PORT = Number(process.env.PORT || 3000);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

// 같은 세계에 대한 시뮬레이션이 동시에 두 번 돌지 않게 막는다.
const running = new Map();

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

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function serveStatic(req, res, pathname) {
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

async function advanceStream(req, res, world, input) {
  if (running.has(world.id)) throw httpError(409, '이미 이 세계의 시뮬레이션이 진행 중입니다');
  if (!isValidDate(input.targetDate)) throw httpError(400, '목표 날짜(YYYY-MM-DD)를 입력하세요');
  if (compareDates(input.targetDate, world.currentDate) <= 0) throw httpError(400, '목표 날짜는 현재 날짜 이후여야 합니다');

  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const emit = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  const ctrl = new AbortController();
  let cancelled = false;
  // 응답 스트림이 끊기면(브라우저에서 중지) 진행 중인 모델 호출도 취소한다.
  res.on('close', () => {
    if (!res.writableFinished) {
      cancelled = true;
      ctrl.abort();
    }
  });
  running.set(world.id, true);
  try {
    await engine.advance(world, { targetDate: input.targetDate, unit: input.unit, onProgress: emit, isCancelled: () => cancelled, signal: ctrl.signal });
  } catch (e) {
    if (!cancelled) {
      console.error(e);
      emit({ type: 'error', message: e.message, currentDate: world.currentDate });
    }
  } finally {
    running.delete(world.id);
    res.end();
  }
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  const method = req.method;
  if (parts[0] !== 'api') return serveStatic(req, res, url.pathname);

  const [, resource, id, sub, subId] = parts;

  if (resource === 'info') return send(res, 200, engine.engineInfo());

  if (resource === 'worlds' && !id) {
    if (method === 'GET') return send(res, 200, await store.listWorlds());
    if (method === 'POST') {
      const input = await body(req);
      const world = createWorld(input.sample ? structuredClone(SAMPLE_WORLD) : input);
      return send(res, 201, await store.saveWorld(world));
    }
  }

  if (resource !== 'worlds' || !id) throw httpError(404, 'not found');
  const world = await store.loadWorld(id);
  const busy = () => {
    if (running.has(id)) throw httpError(409, '시뮬레이션 진행 중에는 수정할 수 없습니다');
  };

  if (!sub) {
    if (method === 'GET') return send(res, 200, { ...world, running: running.has(id) });
    if (method === 'PATCH') {
      busy();
      const input = await body(req);
      if (input.name) world.name = String(input.name);
      if (input.setting) world.setting = normalizeSetting({ ...world.setting, ...input.setting });
      if (input.worldSummary != null) world.worldSummary = String(input.worldSummary);
      if (input.currentDate && isValidDate(input.currentDate) && !world.events.length) {
        world.currentDate = world.startDate = input.currentDate;
      }
      return send(res, 200, await store.saveWorld(world));
    }
    if (method === 'DELETE') {
      busy();
      await store.deleteWorld(id);
      return send(res, 200, { ok: true });
    }
  }

  if (sub === 'characters') {
    busy();
    const input = method === 'DELETE' ? {} : await body(req);
    if (method === 'POST' && !subId) {
      const c = addCharacter(world, input);
      await store.saveWorld(world);
      return send(res, 201, c);
    }
    const idx = world.characters.findIndex((c) => c.id === subId);
    if (idx < 0) throw httpError(404, '인물을 찾을 수 없습니다');
    if (method === 'PUT') {
      world.characters[idx] = normalizeCharacter(input, world.characters[idx]);
      await store.saveWorld(world);
      return send(res, 200, world.characters[idx]);
    }
    if (method === 'DELETE') {
      world.characters.splice(idx, 1);
      world.relationships = world.relationships.filter((r) => r.a !== subId && r.b !== subId);
      await store.saveWorld(world);
      return send(res, 200, { ok: true });
    }
  }

  if (sub === 'relationships') {
    busy();
    const input = await body(req);
    if (method === 'PUT') {
      const r = upsertRelationship(world, input);
      if (!r) throw httpError(400, '두 인물을 올바르게 선택하세요');
      await store.saveWorld(world);
      return send(res, 200, r);
    }
    if (method === 'DELETE') {
      const r = findRelationship(world, input.a, input.b);
      world.relationships = world.relationships.filter((x) => x !== r);
      await store.saveWorld(world);
      return send(res, 200, { ok: true });
    }
  }

  if (sub === 'interventions') {
    busy();
    if (method === 'POST') {
      const input = await body(req);
      if (!input.description) throw httpError(400, '사건 내용을 입력하세요');
      const iv = addIntervention(world, input);
      await store.saveWorld(world);
      return send(res, 201, iv);
    }
    if (method === 'DELETE') {
      world.interventions = world.interventions.filter((x) => !(x.id === subId && x.status === 'pending'));
      await store.saveWorld(world);
      return send(res, 200, { ok: true });
    }
  }

  if (sub === 'advance' && method === 'POST') return advanceStream(req, res, world, await body(req));

  if (sub === 'undo' && method === 'POST') {
    busy();
    return send(res, 200, await store.restoreSnapshot(id));
  }
  if (sub === 'snapshots' && method === 'GET') return send(res, 200, await store.listSnapshots(id));

  if (sub === 'scene' && method === 'POST') {
    const { eventId } = await body(req);
    const event = world.events.find((e) => e.id === eventId);
    if (!event) throw httpError(404, '사건을 찾을 수 없습니다');
    const text = await engine.scene(world, event);
    event.scene = text;
    if (!running.has(id)) await store.saveWorld(world);
    return send(res, 200, { text });
  }

  if (sub === 'chronicle' && method === 'POST') {
    const input = await body(req);
    const from = isValidDate(input.from) ? input.from : world.startDate;
    const to = isValidDate(input.to) ? input.to : world.currentDate;
    return send(res, 200, { text: await engine.chronicle(world, from, to) });
  }

  if (sub === 'interview' && method === 'POST') {
    const input = await body(req);
    return send(res, 200, { text: await engine.interview(world, input.characterId, String(input.question || ''), input.history || []) });
  }

  if (sub === 'generate-character' && method === 'POST') {
    const input = await body(req);
    return send(res, 200, normalizeCharacter(await engine.generateCharacter(world, String(input.brief || ''))));
  }

  if (sub === 'export' && method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${id}.json"` });
    return res.end(JSON.stringify(world, null, 2));
  }

  throw httpError(404, 'not found');
}

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (e) {
    if (res.headersSent) return res.end();
    const status = e.status || (e instanceof SyntaxError ? 400 : 500);
    if (status >= 500) console.error(e);
    send(res, status, { error: e.message });
  }
});

server.listen(PORT, () => {
  const info = engine.engineInfo();
  console.log(`시나리오 시뮬레이터: http://localhost:${PORT}`);
  console.log(info.mock ? '⚠ 모의 모드 (ANTHROPIC_API_KEY가 없거나 SIM_MOCK=1)' : `모델: ${info.model} (effort: ${info.effort})`);
});
