import Anthropic from '@anthropic-ai/sdk';
import { buildContext, findCharacter, BIG_FIVE } from './world.js';
import { ageAt } from './dates.js';
import { config, onConfigChange } from './config.js';

let client = null;
onConfigChange(() => (client = null));
function getClient() {
  // 모바일 앱에서는 웹뷰가 직접 API를 호출한다. 키는 사용자가 자기 기기에 넣은 본인 키다.
  client ??= new Anthropic({ apiKey: config.apiKey, dangerouslyAllowBrowser: config.browser });
  return client;
}

// 가끔 안전 분류기가 요청을 거절할 수 있어 서버 측 대체 모델 재시도를 켠다(Haiku는 미지원).
function fallbackParams() {
  if (config.model.includes('haiku')) return {};
  return { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };
}

const nullableStr = { type: ['string', 'null'] };
const strArray = { type: 'array', items: { type: 'string' } };
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

const STEP_SCHEMA = obj({
  events: {
    type: 'array',
    items: obj({
      date: { type: 'string', description: 'YYYY-MM-DD, 구간 안의 날짜' },
      title: { type: 'string' },
      description: { type: 'string' },
      involved: { ...strArray, description: '관련 인물 id' },
      kind: { type: 'string', enum: ['life', 'relationship', 'conflict', 'turning_point', 'world', 'god'] },
      importance: { type: 'integer', description: '1(사소함)~5(인생을 바꿈)' },
      storyline: nullableStr,
      interventionId: nullableStr,
    }),
  },
  characterUpdates: {
    type: 'array',
    items: obj({
      id: { type: 'string' },
      location: nullableStr,
      occupation: nullableStr,
      status: {
        type: ['object', 'null'],
        properties: { health: nullableStr, wealth: nullableStr, mood: nullableStr, social: nullableStr },
        required: ['health', 'wealth', 'mood', 'social'],
        additionalProperties: false,
      },
      personalityShift: {
        type: ['object', 'null'],
        description: '빅파이브 변화량(-10~10). 큰 사건이 아니면 0 또는 ±1~3',
        properties: Object.fromEntries(Object.keys(BIG_FIVE).map((k) => [k, { type: 'integer' }])),
        required: Object.keys(BIG_FIVE),
        additionalProperties: false,
      },
      addTraits: strArray,
      removeTraits: strArray,
      goals: { ...strArray, description: '목표가 바뀌었을 때만 전체 목록, 아니면 빈 배열' },
      newMemories: { type: 'array', items: obj({ text: { type: 'string' }, importance: { type: 'integer' } }) },
      lifeSummary: { type: 'string', description: '지금까지의 인생 요약(갱신본, 3~6문장)' },
      died: { type: 'boolean' },
    }),
  },
  relationshipUpdates: {
    type: 'array',
    items: obj({
      a: { type: 'string' },
      b: { type: 'string' },
      type: { type: 'string' },
      affinity: { type: 'integer', description: '-100~100' },
      trust: { type: 'integer', description: '0~100' },
      notes: { type: 'string' },
      change: { type: 'string', description: '이번 구간에 관계가 어떻게 변했는지 한 문장' },
    }),
  },
  storylineUpdates: {
    type: 'array',
    items: obj({
      id: { ...nullableStr, description: '기존 이야기 id, 새 이야기면 null' },
      title: { type: 'string' },
      status: { type: 'string', enum: ['open', 'escalating', 'dormant', 'resolved'] },
      summary: { type: 'string' },
      involved: strArray,
      beat: { type: 'string', description: '이번 구간에 이 이야기에서 일어난 일' },
      resolution: nullableStr,
    }),
  },
  newCharacters: {
    type: 'array',
    description: '이야기에 의미 있게 등장한 새 인물만',
    items: obj({
      name: { type: 'string' },
      gender: { type: 'string' },
      birthDate: { type: 'string' },
      occupation: { type: 'string' },
      location: { type: 'string' },
      traits: strArray,
      backstory: { type: 'string' },
      goals: strArray,
    }),
  },
  interventionOutcomes: { type: 'array', items: obj({ id: { type: 'string' }, outcome: { type: 'string' } }) },
  worldSummary: { type: 'string', description: '세계/사회 정세와 인물 주변 상황 요약(갱신본)' },
  periodSummary: { type: 'string', description: '이번 구간을 한두 문장으로' },
});

const SIM_SYSTEM = `당신은 "세계 시뮬레이션 엔진"이다. 사용자가 만든 가상 세계에서 인물들이 실제로 살아가는 모습을 시간 순서대로 시뮬레이션한다.

원칙
- 인물은 각자의 성격(빅파이브 0~100), 가치관, 목표, 두려움, 비밀, 관계, 기억에 따라 스스로 판단하고 행동한다. 작가의 편의가 아니라 인물의 내적 동기로 행동이 나와야 한다.
- 시대와 장소의 고증을 지킨다: 당시의 사회 제도, 계급, 성별 규범, 기술, 의료, 경제, 실제 역사적 사건(있다면)이 삶에 영향을 준다. 시대에 없는 물건이나 개념을 쓰지 않는다.
- setting.realism이 높을수록 일상적이고 개연성 있는 변화 위주, 낮을수록 극적인 우연을 허용한다. setting.eventDensity가 높을수록 사건을 많이 만든다.
- 삶은 연속적이다. 지난 사건과 열린 이야기(activeStorylines)의 결과가 이어지고, 갈등은 자연스럽게 커지거나 해결되거나 흐지부지된다. 해결된 이야기는 status를 resolved로 바꾸고 resolution을 쓴다.
- 인물끼리의 상호작용(만남, 오해, 연애, 경쟁, 우정, 배신, 화해)을 적극적으로 만들되 개연성을 지킨다. 같은 장소/사회에 있는 인물들이 서로 엮이게 한다.
- 성격은 천천히 변한다. 인생을 뒤흔드는 사건에서만 personalityShift를 크게 준다(최대 ±10).
- 나이가 들고, 병들고, 직업이 바뀌고, 이사하고, 결혼하고, 죽기도 한다. 죽은 인물(alive=false)은 행동하지 않는다.
- "신의 개입(interventions)"은 이 세계에서 반드시 일어나는 사건이다. 지정된 날짜에 일어나게 하고, 인물들이 각자의 성격대로 어떻게 반응하는지, 그 여파가 무엇인지 시뮬레이션한다. 해당 사건의 kind는 "god", interventionId를 채우고, interventionOutcomes에 결과를 적는다.
- 모든 인물(죽은 인물 제외)에 대해 characterUpdates를 하나씩 만든다. 변화 없는 필드는 null 또는 빈 배열로 둔다. 기억(newMemories)은 그 인물 관점에서 쓴다.
- 기존 인물은 반드시 주어진 id로 가리킨다. 이야기에서 비중이 생긴 새 인물은 newCharacters에 추가하고, 같은 응답 안에서는 이름으로 가리킨다.
- 모든 서술은 한국어로, 소설처럼 구체적으로(누가, 어디서, 무엇을, 왜) 쓴다. 고유명사는 원어 발음을 한글로 적어도 좋다.
- 날짜는 YYYY-MM-DD이며 반드시 주어진 구간 (from, to] 안이어야 한다.`;

function stepPrompt(world, step, interventions) {
  const ctx = buildContext(world, step);
  return `## 현재 세계 상태
${JSON.stringify(ctx, null, 1)}

## 이번 구간에 일어나야 할 신의 개입
${interventions.length ? JSON.stringify(interventions.map((iv) => ({ id: iv.id, date: iv.date, kind: iv.kind, intensity: iv.intensity, title: iv.title, description: iv.description, targets: iv.targets })), null, 1) : '(없음)'}

## 과제
${step.from} 다음 날부터 ${step.to}까지의 삶을 시뮬레이션하라. 결과를 지정된 JSON 형식으로만 출력하라.`;
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('모델 응답에서 JSON을 찾지 못했습니다');
  return JSON.parse(text.slice(start, end + 1));
}

function textOf(message) {
  return message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

function checkStop(message) {
  if (message.stop_reason === 'refusal') {
    const why = message.stop_details?.explanation || message.stop_details?.category || '';
    throw new Error(`모델이 이 요청을 거절했습니다. 설정이나 개입 내용을 조정해 보세요. ${why}`);
  }
  if (message.stop_reason === 'max_tokens') {
    throw new Error('응답이 너무 길어 잘렸습니다. 시뮬레이션 단위를 더 짧게(예: 1주) 바꿔 보세요.');
  }
}

function friendlyError(e) {
  if (e instanceof Anthropic.AuthenticationError) return new Error('API 키가 올바르지 않습니다. 설정에서 키를 확인하세요.');
  if (e instanceof Anthropic.RateLimitError) return new Error('요청 한도를 넘었습니다. 잠시 후 다시 시도하세요.');
  if (e instanceof Anthropic.APIConnectionError && !(e instanceof Anthropic.APIUserAbortError)) return new Error('Anthropic API에 연결하지 못했습니다. 인터넷 연결을 확인하세요.');
  return e;
}

async function stream(params, options) {
  try {
    return await getClient().beta.messages.stream(params, options).finalMessage();
  } catch (e) {
    throw friendlyError(e);
  }
}

async function call({ system, prompt, maxTokens = 32000, schema, effort = config.effort, signal }) {
  const params = {
    model: config.model,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: prompt }],
    output_config: { effort, ...(schema ? { format: { type: 'json_schema', schema } } : {}) },
    ...fallbackParams(),
  };
  const message = await stream(params, { signal });
  checkStop(message);
  return { text: textOf(message), usage: message.usage };
}

function trackUsage(world, usage) {
  if (!usage) return;
  world.usage ??= { inputTokens: 0, outputTokens: 0, calls: 0 };
  world.usage.inputTokens += (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  world.usage.outputTokens += usage.output_tokens || 0;
  world.usage.calls += 1;
}

async function callJson(world, opts) {
  let res;
  try {
    res = await call(opts);
  } catch (e) {
    // 스키마가 구조화 출력 제약에 맞지 않는 경우 프롬프트 지시만으로 JSON을 받는다.
    if (e instanceof Anthropic.BadRequestError && /schema|output_config|format/i.test(e.message)) {
      res = await call({ ...opts, schema: undefined, prompt: `${opts.prompt}\n\n다음 JSON 스키마를 따르는 JSON 객체 하나만 출력하라:\n${JSON.stringify(opts.schema)}` });
    } else {
      throw e;
    }
  }
  trackUsage(world, res.usage);
  return extractJson(res.text);
}

export async function simulateStep(world, step, interventions, { signal } = {}) {
  return callJson(world, { system: SIM_SYSTEM, prompt: stepPrompt(world, step, interventions), schema: STEP_SCHEMA, signal });
}

const WRITER_SYSTEM = `당신은 사용자가 만든 가상 세계의 기록을 바탕으로 글을 쓰는 소설가다. 시대 고증과 인물의 성격·말투를 정확히 지키고, 주어진 기록과 모순되는 사실을 만들지 않는다. 한국어로 쓴다.`;

function characterCard(world, c) {
  return {
    name: c.name,
    age: ageAt(c.birthDate, world.currentDate),
    alive: c.alive,
    gender: c.gender,
    occupation: c.occupation,
    location: c.location,
    personality: c.personality,
    traits: c.traits,
    values: c.values,
    goals: c.goals,
    fears: c.fears,
    secrets: c.secrets,
    speechStyle: c.speechStyle,
    backstory: c.backstory,
    status: c.status,
    lifeSummary: c.lifeSummary,
    memories: c.memories.slice(-20).map((m) => `${m.date}: ${m.text}`),
  };
}

export async function writeScene(world, event) {
  const people = event.involved.map((id) => findCharacter(world, id)).filter(Boolean);
  const prior = world.events.filter((e) => e.date <= event.date && e.id !== event.id).slice(-10);
  const prompt = `## 세계
${JSON.stringify(world.setting, null, 1)}

## 등장 인물
${JSON.stringify(people.map((c) => characterCard(world, c)), null, 1)}

## 직전 사건들
${prior.map((e) => `- ${e.date} ${e.title}: ${e.description}`).join('\n') || '(없음)'}

## 이 장면의 사건
${event.date} — ${event.title}
${event.description}

이 사건을 소설의 한 장면으로 써라. 장소와 분위기 묘사, 인물들의 대사와 속마음을 넣고, 각 인물의 말투와 성격이 드러나게 하라. 1500~3000자.`;
  const res = await call({ system: WRITER_SYSTEM, prompt, maxTokens: 16000 });
  trackUsage(world, res.usage);
  return res.text;
}

export async function writeChronicle(world, from, to) {
  const events = world.events.filter((e) => e.date > from && e.date <= to);
  const name = (id) => findCharacter(world, id)?.name || id;
  const prompt = `## 세계
${JSON.stringify(world.setting, null, 1)}

## 인물
${JSON.stringify(world.characters.map((c) => characterCard(world, c)), null, 1)}

## ${from} ~ ${to} 사이의 사건 기록
${events.map((e) => `- ${e.date} [${e.involved.map(name).join(', ')}] ${e.title}: ${e.description}`).join('\n') || '(기록 없음)'}

이 기간을 한 편의 연대기(소설의 한 장)로 엮어라. 사건 사이의 인과와 인물들의 감정 변화가 이어지도록 서술하라. 장 제목을 붙여라.`;
  const res = await call({ system: WRITER_SYSTEM, prompt, maxTokens: 32000 });
  trackUsage(world, res.usage);
  return res.text;
}

export async function interview(world, characterId, question, history = []) {
  const c = findCharacter(world, characterId);
  if (!c) throw new Error('인물을 찾을 수 없습니다');
  const rels = world.relationships
    .filter((r) => r.a === c.id || r.b === c.id)
    .map((r) => ({ with: findCharacter(world, r.a === c.id ? r.b : r.a)?.name, type: r.type, affinity: r.affinity, trust: r.trust, notes: r.notes }));
  const system = `당신은 가상 세계 속 인물 "${c.name}"이다. 지금은 ${world.currentDate}, 장소와 시대는 다음과 같다: ${JSON.stringify(world.setting)}.
당신의 인물 정보: ${JSON.stringify(characterCard(world, c))}
당신의 인간관계: ${JSON.stringify(rels)}
질문하는 사람은 당신 앞에 나타난 낯선 존재다. 당신의 성격, 말투, 시대의 지식 수준에 맞게 1인칭으로 대답하라. 당신이 모르는 미래나 다른 사람의 비밀은 알지 못한다. 비밀은 성격상 털어놓을 만할 때만 말한다. 한국어로 답한다.${c.alive ? '' : ' (당신은 이미 세상을 떠났다. 영혼으로서 대답한다.)'}`;
  const messages = [...history.slice(-12), { role: 'user', content: question }];
  const message = await stream({ model: config.model, max_tokens: 8000, system, messages, output_config: { effort: 'low' }, ...fallbackParams() });
  checkStop(message);
  trackUsage(world, message.usage);
  return textOf(message);
}

const CHARACTER_SCHEMA = obj({
  name: { type: 'string' },
  gender: { type: 'string' },
  birthDate: { type: 'string', description: 'YYYY-MM-DD' },
  occupation: { type: 'string' },
  location: { type: 'string' },
  appearance: { type: 'string' },
  personality: obj(Object.fromEntries(Object.keys(BIG_FIVE).map((k) => [k, { type: 'integer' }]))),
  traits: strArray,
  values: { type: 'string' },
  goals: strArray,
  fears: { type: 'string' },
  secrets: { type: 'string' },
  speechStyle: { type: 'string' },
  skills: strArray,
  backstory: { type: 'string' },
  status: obj({ health: { type: 'string' }, wealth: { type: 'string' }, mood: { type: 'string' }, social: { type: 'string' } }),
});

export async function generateCharacter(world, brief) {
  const prompt = `## 세계 설정
${JSON.stringify(world.setting, null, 1)}
현재 날짜: ${world.currentDate}
이미 있는 인물: ${world.characters.map((c) => `${c.name}(${c.occupation})`).join(', ') || '없음'}

## 요청
${brief}

이 세계와 시대에 실제로 살았을 법한 인물 한 명을 자세히 설정하라. 성격(빅파이브 0~100)은 구체적 수치로, 배경 이야기는 시대 고증에 맞게, 목표·두려움·비밀은 앞으로 이야기를 만들어 낼 수 있도록 써라. birthDate는 현재 날짜 기준 나이에 맞게 정하라. 한국어로 쓰되 이름은 그 지역 이름으로 한다.`;
  return callJson(world, { system: WRITER_SYSTEM, prompt, schema: CHARACTER_SCHEMA, maxTokens: 16000, effort: 'low' });
}
