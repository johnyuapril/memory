import { newId } from './store.js';
import { ageAt, compareDates, isValidDate } from './dates.js';

export const BIG_FIVE = {
  openness: '개방성',
  conscientiousness: '성실성',
  extraversion: '외향성',
  agreeableness: '친화성',
  neuroticism: '신경성',
};

const MAX_MEMORIES = 40;
const MAX_EVENTS_IN_WORLD = 5000;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const str = (v) => (v == null ? '' : String(v));
const list = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : str(v).split(/[,\n]/).map((s) => s.trim()).filter(Boolean));

export function createWorld(input = {}) {
  const startDate = isValidDate(input.startDate) ? input.startDate : '1820-05-01';
  const world = {
    id: newId('world'),
    name: str(input.name) || '이름 없는 세계',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startDate,
    currentDate: startDate,
    setting: normalizeSetting(input.setting || input),
    worldSummary: '',
    characters: [],
    relationships: [],
    storylines: [],
    events: [],
    interventions: [],
    usage: { inputTokens: 0, outputTokens: 0, calls: 0 },
  };
  for (const c of input.characters || []) addCharacter(world, c);
  for (const r of input.relationships || []) upsertRelationship(world, r);
  return world;
}

export function normalizeSetting(s = {}) {
  return {
    era: str(s.era),
    location: str(s.location),
    description: str(s.description),
    society: str(s.society),
    rules: str(s.rules),
    tone: str(s.tone) || '사실적',
    realism: clamp(num(s.realism, 70), 0, 100),
    eventDensity: clamp(num(s.eventDensity, 50), 0, 100),
  };
}

export function normalizeCharacter(c = {}, existing = {}) {
  const merged = { ...existing, ...c };
  const p = { ...(existing.personality || {}), ...(c.personality || {}) };
  const st = { ...(existing.status || {}), ...(c.status || {}) };
  return {
    id: existing.id || str(c.id) || newId('char'),
    name: str(merged.name) || '이름 없음',
    gender: str(merged.gender),
    birthDate: isValidDate(merged.birthDate) ? merged.birthDate : '',
    occupation: str(merged.occupation),
    location: str(merged.location),
    appearance: str(merged.appearance),
    personality: Object.fromEntries(Object.keys(BIG_FIVE).map((k) => [k, clamp(num(p[k], 50), 0, 100)])),
    traits: list(merged.traits),
    values: str(merged.values),
    goals: list(merged.goals),
    fears: str(merged.fears),
    secrets: str(merged.secrets),
    speechStyle: str(merged.speechStyle),
    skills: list(merged.skills),
    backstory: str(merged.backstory),
    status: {
      health: str(st.health) || '건강함',
      wealth: str(st.wealth) || '보통',
      mood: str(st.mood) || '평온함',
      social: str(st.social) || '평범함',
    },
    lifeSummary: str(merged.lifeSummary),
    memories: Array.isArray(merged.memories) ? merged.memories : [],
    alive: merged.alive !== false,
    deathDate: str(merged.deathDate),
    isNpc: Boolean(merged.isNpc),
    createdAt: existing.createdAt || new Date().toISOString(),
  };
}

export function addCharacter(world, input) {
  const c = normalizeCharacter(input);
  world.characters.push(c);
  return c;
}

export function findCharacter(world, idOrName) {
  if (!idOrName) return null;
  return (
    world.characters.find((c) => c.id === idOrName) ||
    world.characters.find((c) => c.name === idOrName) ||
    world.characters.find((c) => c.name.split(' ')[0] === idOrName) ||
    null
  );
}

// 모델이 이름으로 인물을 가리켜도 ID로 맞춰 준다.
function resolveIds(world, ids) {
  return (Array.isArray(ids) ? ids : [])
    .map((x) => findCharacter(world, x)?.id)
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i);
}

function relKey(a, b) {
  return [a, b].sort().join('|');
}

export function findRelationship(world, a, b) {
  const k = relKey(a, b);
  return world.relationships.find((r) => relKey(r.a, r.b) === k) || null;
}

export function upsertRelationship(world, input) {
  const a = findCharacter(world, input.a)?.id;
  const b = findCharacter(world, input.b)?.id;
  if (!a || !b || a === b) return null;
  let r = findRelationship(world, a, b);
  if (!r) {
    r = { a, b, type: '아는 사이', affinity: 0, trust: 50, notes: '', history: [] };
    world.relationships.push(r);
  }
  if (input.type) r.type = str(input.type);
  if (input.affinity != null) r.affinity = clamp(num(input.affinity, r.affinity), -100, 100);
  if (input.trust != null) r.trust = clamp(num(input.trust, r.trust), 0, 100);
  if (input.notes != null && input.notes !== '') r.notes = str(input.notes);
  return r;
}

function addMemory(c, mem) {
  c.memories.push(mem);
  if (c.memories.length > MAX_MEMORIES) {
    // 오래되고 덜 중요한 기억부터 잊는다. 큰 흐름은 lifeSummary에 남는다.
    const scored = c.memories.map((m, i) => ({ i, score: num(m.importance, 3) * 10 + i * (10 / c.memories.length) }));
    scored.sort((x, y) => x.score - y.score);
    c.memories.splice(scored[0].i, 1);
  }
}

// 한 구간의 시뮬레이션 결과(모델 출력)를 세계 상태에 반영하고, 새로 생긴 사건 목록을 돌려준다.
export function applyStepResult(world, step, result) {
  const created = [];

  // 새 인물을 먼저 추가해야 같은 결과 안의 사건/관계가 그들을 참조할 수 있다.
  for (const nc of result.newCharacters || []) {
    if (!nc?.name || findCharacter(world, nc.name)) continue;
    addCharacter(world, { ...nc, isNpc: true });
  }

  for (const e of result.events || []) {
    let date = isValidDate(e.date) ? e.date : step.to;
    if (compareDates(date, step.from) <= 0 || compareDates(date, step.to) > 0) date = step.to;
    const ev = {
      id: newId('ev'),
      date,
      title: str(e.title),
      description: str(e.description),
      involved: resolveIds(world, e.involved),
      kind: str(e.kind) || 'life',
      importance: clamp(num(e.importance, 3), 1, 5),
      storyline: str(e.storyline),
      interventionId: str(e.interventionId),
    };
    world.events.push(ev);
    created.push(ev);
  }
  world.events.sort((x, y) => compareDates(x.date, y.date));
  if (world.events.length > MAX_EVENTS_IN_WORLD) world.events.splice(0, world.events.length - MAX_EVENTS_IN_WORLD);

  for (const u of result.characterUpdates || []) {
    const c = findCharacter(world, u.id) || findCharacter(world, u.name);
    if (!c) continue;
    for (const f of ['location', 'occupation', 'appearance', 'speechStyle', 'values', 'fears', 'secrets']) {
      if (u[f]) c[f] = str(u[f]);
    }
    if (u.status) for (const k of Object.keys(c.status)) if (u.status[k]) c.status[k] = str(u.status[k]);
    if (u.personalityShift) {
      for (const k of Object.keys(BIG_FIVE)) {
        const d = clamp(num(u.personalityShift[k], 0), -10, 10);
        c.personality[k] = clamp(c.personality[k] + d, 0, 100);
      }
    }
    if (Array.isArray(u.addTraits)) for (const t of u.addTraits) if (t && !c.traits.includes(t)) c.traits.push(str(t));
    if (Array.isArray(u.removeTraits)) c.traits = c.traits.filter((t) => !u.removeTraits.includes(t));
    if (Array.isArray(u.goals) && u.goals.length) c.goals = list(u.goals);
    for (const m of u.newMemories || []) {
      const text = typeof m === 'string' ? m : m?.text;
      if (text) addMemory(c, { date: isValidDate(m.date) ? m.date : step.to, text: str(text), importance: clamp(num(m.importance, 3), 1, 5) });
    }
    if (u.lifeSummary) c.lifeSummary = str(u.lifeSummary);
    if (u.died && c.alive) {
      c.alive = false;
      c.deathDate = isValidDate(u.deathDate) ? u.deathDate : step.to;
    }
  }

  for (const r of result.relationshipUpdates || []) {
    const rel = upsertRelationship(world, r);
    if (rel && r.change) rel.history.push({ date: step.to, text: str(r.change) });
    if (rel && rel.history.length > 20) rel.history.shift();
  }

  for (const s of result.storylineUpdates || []) {
    let sl = world.storylines.find((x) => x.id === s.id) || world.storylines.find((x) => x.title === s.title);
    if (!sl) {
      if (!s.title) continue;
      sl = { id: newId('story'), title: str(s.title), status: 'open', summary: '', involved: [], startedAt: step.to, resolvedAt: '', resolution: '', beats: [] };
      world.storylines.push(sl);
    }
    if (s.title) sl.title = str(s.title);
    if (s.summary) sl.summary = str(s.summary);
    if (Array.isArray(s.involved) && s.involved.length) sl.involved = resolveIds(world, s.involved);
    if (s.beat) sl.beats.push({ date: step.to, text: str(s.beat) });
    if (s.status === 'resolved' && sl.status !== 'resolved') {
      sl.status = 'resolved';
      sl.resolvedAt = step.to;
      sl.resolution = str(s.resolution);
    } else if (s.status === 'open' || s.status === 'escalating' || s.status === 'dormant') {
      sl.status = s.status;
    }
  }

  for (const o of result.interventionOutcomes || []) {
    const iv = world.interventions.find((x) => x.id === o.id);
    if (iv) {
      iv.status = 'applied';
      iv.outcome = str(o.outcome);
      iv.appliedAt = step.to;
    }
  }
  // 모델이 결과를 빠뜨렸더라도 이 구간에 해당하는 개입은 반영된 것으로 처리한다.
  for (const iv of interventionsForStep(world, step)) {
    iv.status = 'applied';
    iv.appliedAt = iv.appliedAt || step.to;
  }

  if (result.worldSummary) world.worldSummary = str(result.worldSummary);
  world.currentDate = step.to;
  return created;
}

export function interventionsForStep(world, step) {
  return world.interventions.filter((iv) => iv.status === 'pending' && compareDates(iv.date, step.to) <= 0);
}

export function addIntervention(world, input) {
  const iv = {
    id: newId('god'),
    date: isValidDate(input.date) ? input.date : world.currentDate,
    title: str(input.title) || str(input.description).slice(0, 30),
    description: str(input.description),
    targets: resolveIds(world, input.targets),
    kind: str(input.kind) || '사건',
    intensity: clamp(num(input.intensity, 3), 1, 5),
    status: 'pending',
    outcome: '',
    createdAt: new Date().toISOString(),
  };
  if (compareDates(iv.date, world.currentDate) < 0) iv.date = world.currentDate;
  world.interventions.push(iv);
  return iv;
}

// 모델에 넘길 세계 상태. 토큰을 아끼기 위해 최근 사건과 열린 이야기 위주로 줄인다.
export function buildContext(world, step) {
  const name = (id) => findCharacter(world, id)?.name || id;
  return {
    world: {
      name: world.name,
      setting: world.setting,
      worldSummary: world.worldSummary,
      currentDate: world.currentDate,
    },
    characters: world.characters.map((c) => ({
      id: c.id,
      name: c.name,
      age: ageAt(c.birthDate, step.from),
      alive: c.alive,
      ...(c.alive ? {} : { deathDate: c.deathDate }),
      isNpc: c.isNpc,
      gender: c.gender,
      occupation: c.occupation,
      location: c.location,
      appearance: c.appearance,
      personality: c.personality,
      traits: c.traits,
      values: c.values,
      goals: c.goals,
      fears: c.fears,
      secrets: c.secrets,
      speechStyle: c.speechStyle,
      skills: c.skills,
      backstory: c.backstory,
      status: c.status,
      lifeSummary: c.lifeSummary,
      recentMemories: c.memories.slice(-12).map((m) => `${m.date}: ${m.text}`),
    })),
    relationships: world.relationships.map((r) => ({
      a: r.a,
      b: r.b,
      between: `${name(r.a)} ↔ ${name(r.b)}`,
      type: r.type,
      affinity: r.affinity,
      trust: r.trust,
      notes: r.notes,
    })),
    activeStorylines: world.storylines
      .filter((s) => s.status !== 'resolved')
      .map((s) => ({ id: s.id, title: s.title, status: s.status, summary: s.summary, involved: s.involved.map(name), recentBeats: s.beats.slice(-3) })),
    recentlyResolved: world.storylines
      .filter((s) => s.status === 'resolved')
      .slice(-5)
      .map((s) => ({ title: s.title, resolution: s.resolution, resolvedAt: s.resolvedAt })),
    recentEvents: world.events.slice(-25).map((e) => ({ date: e.date, title: e.title, description: e.description, involved: e.involved.map(name) })),
  };
}
