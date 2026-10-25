// API 키 없이 UI와 흐름을 확인하기 위한 가짜 엔진. 무작위 템플릿으로 그럴듯한 결과 형태만 만든다.
import { findCharacter, findRelationship } from './world.js';
import { addDays, daysBetween } from './dates.js';

const SOLO = [
  ['평범한 나날', '{a}은(는) {loc}에서 일상을 보내며 {goal}에 대해 곰곰이 생각했다.'],
  ['작은 성취', '{a}은(는) 오랫동안 애쓴 일에서 작은 성과를 거두었다.'],
  ['몸살', '{a}은(는) 며칠 동안 몸살을 앓았다.'],
  ['뜻밖의 편지', '{a}에게 오래전 알던 사람에게서 편지가 왔다.'],
];
const PAIR = [
  ['우연한 만남', '{a}와(과) {b}은(는) {loc}에서 우연히 마주쳐 긴 이야기를 나누었다.', 8],
  ['말다툼', '{a}와(과) {b}은(는) 사소한 오해로 크게 다투었다.', -12],
  ['도움', '{a}은(는) 곤경에 처한 {b}을(를) 도와주었다.', 10],
  ['질투', '{a}은(는) {b}의 성공을 보며 묘한 질투를 느꼈다.', -6],
];
const MOODS = ['평온함', '들뜸', '불안함', '우울함', '설렘', '지침', '의욕적임'];

function rng(seed) {
  let s = 0;
  for (const ch of seed) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export async function simulateStepMock(world, step, interventions) {
  await new Promise((r) => setTimeout(r, 150));
  const rand = rng(world.id + step.to);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const alive = world.characters.filter((c) => c.alive);
  const span = Math.max(1, daysBetween(step.from, step.to));
  const dateIn = () => addDays(step.from, 1 + Math.floor(rand() * span));
  const fill = (t, a, b) =>
    t.replaceAll('{a}', a.name).replaceAll('{b}', b?.name || '').replaceAll('{loc}', a.location || '동네').replaceAll('{goal}', a.goals[0] || '앞날');

  const result = { events: [], characterUpdates: [], relationshipUpdates: [], storylineUpdates: [], newCharacters: [], interventionOutcomes: [], worldSummary: world.worldSummary || `${world.setting.location}의 나날이 흘러간다.` };
  const count = 1 + Math.floor(rand() * Math.min(3, alive.length + 1));
  for (let i = 0; i < count && alive.length; i++) {
    const a = pick(alive);
    const others = alive.filter((c) => c.id !== a.id);
    if (others.length && rand() < 0.6) {
      const b = pick(others);
      const [title, desc, delta] = pick(PAIR);
      result.events.push({ date: dateIn(), title, description: fill(desc, a, b), involved: [a.id, b.id], kind: 'relationship', importance: 2 });
      const r = findRelationship(world, a.id, b.id);
      result.relationshipUpdates.push({ a: a.id, b: b.id, type: r?.type || '아는 사이', affinity: (r?.affinity || 0) + delta, trust: r?.trust ?? 50, notes: r?.notes || '', change: title });
    } else {
      const [title, desc] = pick(SOLO);
      result.events.push({ date: dateIn(), title, description: fill(desc, a), involved: [a.id], kind: 'life', importance: 1 });
    }
  }
  for (const iv of interventions) {
    const targets = iv.targets.length ? iv.targets : alive.slice(0, 2).map((c) => c.id);
    const names = targets.map((id) => findCharacter(world, id)?.name).join(', ');
    result.events.push({ date: iv.date, title: `[신의 개입] ${iv.title}`, description: `${iv.description} — ${names}은(는) 크게 동요했다.`, involved: targets, kind: 'god', importance: 4, interventionId: iv.id });
    result.interventionOutcomes.push({ id: iv.id, outcome: `(모의) ${names}의 삶에 파문이 일었다.` });
    result.storylineUpdates.push({ id: null, title: `${iv.title}의 여파`, status: 'open', summary: iv.description, involved: targets, beat: '사건이 일어났다.', resolution: null });
  }
  for (const c of alive) {
    const mine = result.events.filter((e) => e.involved.includes(c.id));
    result.characterUpdates.push({
      id: c.id,
      status: { health: null, wealth: null, mood: pick(MOODS), social: null },
      personalityShift: null,
      newMemories: mine.map((e) => ({ text: e.description, importance: e.importance })),
      lifeSummary: c.lifeSummary || c.backstory,
    });
  }
  result.periodSummary = `${step.from} ~ ${step.to}: 사건 ${result.events.length}건 (모의 실행)`;
  return result;
}
