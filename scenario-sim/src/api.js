// REST 라우팅. 서버(server.js)와 모바일 앱(mobile/entry.js)이 같은 코드를 쓴다.
import * as store from './store.js';
import * as engine from './engine.js';
import { createWorld, normalizeCharacter, normalizeSetting, addCharacter, upsertRelationship, addIntervention, findRelationship } from './world.js';
import { isValidDate, compareDates } from './dates.js';
import { SAMPLE_WORLD } from './sample.js';

// 같은 세계에 대한 시뮬레이션이 동시에 두 번 돌지 않게 막는다.
const running = new Map();

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const ok = (data, status = 200) => ({ status, data });

// 시뮬레이션은 오래 걸리므로 검증만 먼저 하고, 실제 실행은 돌려준 함수로 진행 상황을 흘려보내며 한다.
export async function startAdvance(id, input) {
  const world = await store.loadWorld(id);
  if (running.has(world.id)) throw httpError(409, '이미 이 세계의 시뮬레이션이 진행 중입니다');
  if (!isValidDate(input.targetDate)) throw httpError(400, '목표 날짜(YYYY-MM-DD)를 입력하세요');
  if (compareDates(input.targetDate, world.currentDate) <= 0) throw httpError(400, '목표 날짜는 현재 날짜 이후여야 합니다');
  running.set(world.id, true);

  return async (emit, { isCancelled = () => false, signal } = {}) => {
    try {
      await engine.advance(world, { targetDate: input.targetDate, unit: input.unit, onProgress: emit, isCancelled, signal });
    } catch (e) {
      if (!isCancelled()) {
        console.error(e);
        emit({ type: 'error', message: e.message, currentDate: world.currentDate });
      }
    } finally {
      running.delete(world.id);
    }
  };
}

export function isAdvanceRoute(method, pathname) {
  return method === 'POST' && /^\/api\/worlds\/[\w-]+\/advance$/.test(pathname);
}

export async function handleApi(method, pathname, input = {}) {
  const [, , resource, id, sub, subId] = pathname.split('/');

  if (resource === 'info') return ok(engine.engineInfo());

  if (resource === 'worlds' && !id) {
    if (method === 'GET') return ok(await store.listWorlds());
    if (method === 'POST') {
      const world = createWorld(input.sample ? structuredClone(SAMPLE_WORLD) : input);
      return ok(await store.saveWorld(world), 201);
    }
  }

  if (resource !== 'worlds' || !id) throw httpError(404, 'not found');
  const world = await store.loadWorld(id);
  const busy = () => {
    if (running.has(id)) throw httpError(409, '시뮬레이션 진행 중에는 수정할 수 없습니다');
  };

  if (!sub) {
    if (method === 'GET') return ok({ ...world, running: running.has(id) });
    if (method === 'PATCH') {
      busy();
      if (input.name) world.name = String(input.name);
      if (input.setting) world.setting = normalizeSetting({ ...world.setting, ...input.setting });
      if (input.worldSummary != null) world.worldSummary = String(input.worldSummary);
      if (input.currentDate && isValidDate(input.currentDate) && !world.events.length) {
        world.currentDate = world.startDate = input.currentDate;
      }
      return ok(await store.saveWorld(world));
    }
    if (method === 'DELETE') {
      busy();
      await store.deleteWorld(id);
      return ok({ ok: true });
    }
  }

  if (sub === 'characters') {
    busy();
    if (method === 'POST' && !subId) {
      const c = addCharacter(world, input);
      await store.saveWorld(world);
      return ok(c, 201);
    }
    const idx = world.characters.findIndex((c) => c.id === subId);
    if (idx < 0) throw httpError(404, '인물을 찾을 수 없습니다');
    if (method === 'PUT') {
      world.characters[idx] = normalizeCharacter(input, world.characters[idx]);
      await store.saveWorld(world);
      return ok(world.characters[idx]);
    }
    if (method === 'DELETE') {
      world.characters.splice(idx, 1);
      world.relationships = world.relationships.filter((r) => r.a !== subId && r.b !== subId);
      await store.saveWorld(world);
      return ok({ ok: true });
    }
  }

  if (sub === 'relationships') {
    busy();
    if (method === 'PUT') {
      const r = upsertRelationship(world, input);
      if (!r) throw httpError(400, '두 인물을 올바르게 선택하세요');
      await store.saveWorld(world);
      return ok(r);
    }
    if (method === 'DELETE') {
      const r = findRelationship(world, input.a, input.b);
      world.relationships = world.relationships.filter((x) => x !== r);
      await store.saveWorld(world);
      return ok({ ok: true });
    }
  }

  if (sub === 'interventions') {
    busy();
    if (method === 'POST') {
      if (!input.description) throw httpError(400, '사건 내용을 입력하세요');
      const iv = addIntervention(world, input);
      await store.saveWorld(world);
      return ok(iv, 201);
    }
    if (method === 'DELETE') {
      world.interventions = world.interventions.filter((x) => !(x.id === subId && x.status === 'pending'));
      await store.saveWorld(world);
      return ok({ ok: true });
    }
  }

  if (sub === 'undo' && method === 'POST') {
    busy();
    return ok(await store.restoreSnapshot(id));
  }
  if (sub === 'snapshots' && method === 'GET') return ok(await store.listSnapshots(id));

  if (sub === 'scene' && method === 'POST') {
    const event = world.events.find((e) => e.id === input.eventId);
    if (!event) throw httpError(404, '사건을 찾을 수 없습니다');
    const text = await engine.scene(world, event);
    event.scene = text;
    if (!running.has(id)) await store.saveWorld(world);
    return ok({ text });
  }

  if (sub === 'chronicle' && method === 'POST') {
    const from = isValidDate(input.from) ? input.from : world.startDate;
    const to = isValidDate(input.to) ? input.to : world.currentDate;
    return ok({ text: await engine.chronicle(world, from, to) });
  }

  if (sub === 'interview' && method === 'POST') {
    return ok({ text: await engine.interview(world, input.characterId, String(input.question || ''), input.history || []) });
  }

  if (sub === 'generate-character' && method === 'POST') {
    return ok(normalizeCharacter(await engine.generateCharacter(world, String(input.brief || ''))));
  }

  if (sub === 'export' && method === 'GET') return ok(world);

  throw httpError(404, 'not found');
}
