const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const BIG_FIVE = { openness: '개방성', conscientiousness: '성실성', extraversion: '외향성', agreeableness: '친화성', neuroticism: '신경성' };
const KIND_LABEL = { life: '일상', relationship: '관계', conflict: '갈등', turning_point: '전환점', world: '세상', god: '신의 개입' };
const STATUS_LABEL = { open: '진행 중', escalating: '고조', dormant: '잠잠함', resolved: '해결' };

let world = null;
let running = null; // 진행 중인 시뮬레이션의 AbortController
let interviewHistory = [];
let interviewCharId = null;

// 안드로이드 앱에서는 서버 없이 기기 안의 API(mobile/entry.js)가 같은 경로를 처리한다.
const local = window.localApi;

async function api(path, opts = {}) {
  if (local) return local.request(opts.method || 'GET', `/api${path}`, opts.body);
  const res = await fetch(`/api${path}`, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
  return data;
}

function toast(msg) {
  alert(msg);
}

async function withBusy(btn, fn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '생각 중…';
  try {
    return await fn();
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// ---------- 날짜 ----------
function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(2000, m - 1, d));
  dt.setUTCFullYear(y);
  return dt;
}
function fmt(dt) {
  return `${String(dt.getUTCFullYear()).padStart(4, '0')}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}
function jump(s, spec) {
  const dt = parseDate(s);
  const n = parseInt(spec, 10);
  if (spec.endsWith('d')) dt.setUTCDate(dt.getUTCDate() + n);
  if (spec.endsWith('m')) dt.setUTCMonth(dt.getUTCMonth() + n);
  if (spec.endsWith('y')) dt.setUTCFullYear(dt.getUTCFullYear() + n);
  return fmt(dt);
}
function ageAt(birth, on) {
  if (!birth) return null;
  const b = parseDate(birth), d = parseDate(on);
  let a = d.getUTCFullYear() - b.getUTCFullYear();
  if (d.getUTCMonth() < b.getUTCMonth() || (d.getUTCMonth() === b.getUTCMonth() && d.getUTCDate() < b.getUTCDate())) a--;
  return a;
}
function prettyDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return `${y}년 ${m}월 ${d}일`;
}
const charName = (id) => world.characters.find((c) => c.id === id)?.name || id;

// ---------- 세계 목록 ----------
async function loadInfo() {
  const info = await api('/info');
  const el = $('#engine-info');
  el.textContent = info.mock ? `모의 모드 — API 키 없음${local ? ' (⚙ 설정에서 입력)' : ''}` : `엔진: ${info.model} · ${info.effort}`;
  el.classList.toggle('mock', info.mock);
  $('#btn-app-settings').hidden = !local;
  return info;
}

async function refreshWorldList() {
  const worlds = await api('/worlds');
  $('#world-list').innerHTML = worlds
    .map((w) => `<li data-id="${w.id}" class="${world?.id === w.id ? 'active' : ''}">${esc(w.name)}<small>${esc(w.currentDate)} · 인물 ${w.characterCount}명</small></li>`)
    .join('') || '<li class="hint">아직 세계가 없습니다</li>';
}

async function openWorld(id) {
  world = await api(`/worlds/${id}`);
  localStorage.setItem('lastWorld', id);
  render();
  refreshWorldList();
}

// ---------- 렌더링 ----------
function render() {
  $('#empty').hidden = !!world;
  $('#world').hidden = !world;
  if (!world) return;
  $('#world-name').textContent = world.name;
  $('#world-where').textContent = [world.setting.era, world.setting.location].filter(Boolean).join(' · ');
  $('#current-date').textContent = prettyDate(world.currentDate);
  const target = $('#target-date');
  target.min = jump(world.currentDate, '1d');
  if (!target.value || target.value <= world.currentDate) target.value = jump(world.currentDate, '1m');
  renderTimeline();
  renderCharacters();
  renderRelations();
  renderStories();
  renderGod();
  renderSettings();
}

function characterOptions(withAll) {
  return (withAll ? '<option value="">모든 인물</option>' : '') + world.characters.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
}

function eventHtml(e) {
  return `<div class="event ${e.kind === 'god' ? 'god' : ''} imp-${e.importance}" data-id="${e.id}">
    <div class="title">${esc(e.title)}</div>
    <div>${esc(e.description)}</div>
    <div class="who"><span class="chip">${KIND_LABEL[e.kind] || e.kind}</span>${e.involved.map((id) => esc(charName(id))).join(', ')}</div>
    <div class="actions"><button data-scene="${e.id}">${e.scene ? '장면 다시 보기' : '🎬 장면으로 보기'}</button></div>
  </div>`;
}

function renderTimeline() {
  const sel = $('#timeline-filter');
  const prev = sel.value;
  sel.innerHTML = characterOptions(true);
  sel.value = prev;
  const minImp = Number($('#timeline-importance').value);
  const events = world.events.filter((e) => (!sel.value || e.involved.includes(sel.value)) && e.importance >= minImp);
  if (!events.length) {
    $('#timeline').innerHTML = `<p class="hint">아직 기록된 사건이 없습니다. 위에서 목표 날짜를 정하고 "시간 흐르게 하기"를 누르세요.</p>`;
    return;
  }
  const byDate = new Map();
  for (const e of events.slice().reverse()) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }
  $('#timeline').innerHTML = [...byDate]
    .map(([d, evs]) => `<div class="day"><div class="day-date">${d}</div><div>${evs.map(eventHtml).join('')}</div></div>`)
    .join('');
}

function bars(p) {
  return `<div class="traits-bars">${Object.entries(BIG_FIVE).map(([k, l]) => `<span>${l}</span><div class="b"><span style="width:${p[k]}%"></span></div>`).join('')}</div>`;
}

function renderCharacters() {
  $('#character-grid').innerHTML = world.characters
    .map((c) => {
      const age = ageAt(c.birthDate, c.alive ? world.currentDate : c.deathDate || world.currentDate);
      return `<div class="card ${c.alive ? '' : 'dead'}">
        <h3>${esc(c.name)} ${c.alive ? '' : '✝'}</h3>
        <div class="meta">${[c.gender, age != null ? `${age}세` : '', c.occupation].filter(Boolean).map(esc).join(' · ')}<br>📍 ${esc(c.location || '—')}</div>
        <div>${c.traits.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>
        ${bars(c.personality)}
        <div class="meta">건강 ${esc(c.status.health)} · 재산 ${esc(c.status.wealth)} · 기분 ${esc(c.status.mood)}</div>
        <div class="summary">${esc(c.lifeSummary || c.backstory)}</div>
        <div class="actions">
          <button data-edit="${c.id}">상세/수정</button>
          <button data-interview="${c.id}">💬 대화하기</button>
        </div>
      </div>`;
    })
    .join('') || '<p class="hint">인물을 추가하세요.</p>';
}

function renderRelations() {
  const form = $('#rel-form');
  for (const name of ['a', 'b']) {
    const prev = form[name].value;
    form[name].innerHTML = characterOptions(false);
    if (prev) form[name].value = prev;
  }
  if (form.a.value === form.b.value && world.characters[1]) form.b.value = world.characters[1].id;
  fillRelForm();

  $('#rel-list').innerHTML = world.relationships
    .map((r) => `<div class="rel" data-a="${r.a}" data-b="${r.b}"><b>${esc(charName(r.a))} ↔ ${esc(charName(r.b))}</b> — ${esc(r.type)}
      <span class="${r.affinity >= 0 ? 'pos' : 'neg'}">호감 ${r.affinity}</span> · 신뢰 ${r.trust}
      ${r.notes ? `<div class="hint">${esc(r.notes)}</div>` : ''}
      ${r.history?.length ? `<div class="hint">최근: ${esc(r.history.at(-1).text)}</div>` : ''}</div>`)
    .join('');

  // 원형 배치의 간단한 관계도
  const svg = $('#rel-graph');
  const n = world.characters.length;
  const pos = {};
  world.characters.forEach((c, i) => {
    const a = (i / Math.max(n, 1)) * Math.PI * 2 - Math.PI / 2;
    pos[c.id] = { x: 300 + Math.cos(a) * 220, y: 300 + Math.sin(a) * 220 };
  });
  const edges = world.relationships
    .filter((r) => pos[r.a] && pos[r.b])
    .map((r) => {
      const p = pos[r.a], q = pos[r.b];
      const color = r.affinity >= 0 ? `rgba(47,125,79,${0.25 + r.affinity / 140})` : `rgba(178,58,58,${0.25 - r.affinity / 140})`;
      const w = 1 + Math.abs(r.affinity) / 25;
      return `<line x1="${p.x}" y1="${p.y}" x2="${q.x}" y2="${q.y}" stroke="${color}" stroke-width="${w}"/>
        <text class="edge-label" x="${(p.x + q.x) / 2}" y="${(p.y + q.y) / 2}" text-anchor="middle">${esc(r.type)}</text>`;
    });
  const nodes = world.characters.map((c) => {
    const p = pos[c.id];
    return `<circle cx="${p.x}" cy="${p.y}" r="${c.isNpc ? 7 : 11}" fill="${c.alive ? 'var(--accent)' : 'var(--muted)'}"/>
      <text x="${p.x}" y="${p.y - 16}" text-anchor="middle">${esc(c.name)}</text>`;
  });
  svg.innerHTML = edges.join('') + nodes.join('');
}

function storyHtml(s) {
  return `<div class="story ${s.status === 'resolved' ? 'resolved' : ''}">
    <b>${esc(s.title)}</b> <span class="chip">${STATUS_LABEL[s.status] || s.status}</span>
    <div class="hint">${esc(s.startedAt)}${s.resolvedAt ? ` → ${esc(s.resolvedAt)}` : ''} · ${s.involved.map((id) => esc(charName(id))).join(', ')}</div>
    <div>${esc(s.summary)}</div>
    ${s.resolution ? `<div><b>결말:</b> ${esc(s.resolution)}</div>` : ''}
    ${s.beats?.length ? `<ol>${s.beats.map((b) => `<li>${esc(b.date)} ${esc(b.text)}</li>`).join('')}</ol>` : ''}
  </div>`;
}

function renderStories() {
  const open = world.storylines.filter((s) => s.status !== 'resolved');
  const done = world.storylines.filter((s) => s.status === 'resolved');
  $('#stories-open').innerHTML = open.map(storyHtml).join('') || '<p class="hint">시간이 흐르면 인물들 사이에서 이야기가 생겨납니다.</p>';
  $('#stories-resolved').innerHTML = done.slice().reverse().map(storyHtml).join('') || '<p class="hint">아직 없습니다.</p>';
}

function renderGod() {
  const form = $('#god-form');
  if (!form.date.value || form.date.value < world.currentDate) form.date.value = world.currentDate;
  form.date.min = world.currentDate;
  $('#god-targets').innerHTML = world.characters
    .filter((c) => c.alive)
    .map((c) => `<label><input type="checkbox" value="${c.id}"> ${esc(c.name)}</label>`)
    .join('');
  $('#god-list').innerHTML = world.interventions
    .slice()
    .reverse()
    .map((iv) => `<div class="iv ${iv.status}">
      <b>${esc(iv.title)}</b> <span class="chip">${esc(iv.kind)} · 강도 ${iv.intensity}</span> <span class="chip">${iv.status === 'pending' ? '예약됨' : '일어남'}</span>
      <div class="hint">${esc(iv.date)} · ${iv.targets.map((id) => esc(charName(id))).join(', ') || '세계 전체'}</div>
      <div>${esc(iv.description)}</div>
      ${iv.outcome ? `<div class="outcome"><b>결과:</b> ${esc(iv.outcome)}</div>` : ''}
      ${iv.status === 'pending' ? `<button data-cancel-iv="${iv.id}">취소</button>` : ''}
    </div>`)
    .join('') || '<p class="hint">아직 개입한 적이 없습니다.</p>';
}

function renderSettings() {
  const f = $('#settings-form');
  f.name.value = world.name;
  for (const k of ['era', 'location', 'description', 'society', 'rules', 'tone', 'realism', 'eventDensity']) f[k].value = world.setting[k];
  f.worldSummary.value = world.worldSummary || '';
  $$('input[type=range]', f).forEach((r) => (r.nextElementSibling.textContent = r.value));
  if (!local) $('#btn-export').href = `/api/worlds/${world.id}/export`;
  const u = world.usage || {};
  $('#usage').textContent = `모델 호출 ${u.calls || 0}회 · 입력 ${(u.inputTokens || 0).toLocaleString()} 토큰 · 출력 ${(u.outputTokens || 0).toLocaleString()} 토큰`;
}

// ---------- 시뮬레이션 실행 ----------
async function runSimulation(targetDate) {
  if (running) return;
  const unit = $('#step-unit').value;
  running = new AbortController();
  $('#btn-run').hidden = true;
  $('#btn-stop').hidden = false;
  $('#progress').hidden = false;
  $('#progress-feed').innerHTML = '';
  $('#progress-bar').style.width = '0';
  const feed = (html) => $('#progress-feed').insertAdjacentHTML('afterbegin', `<li>${html}</li>`);
  let failed = null;
  const onEvent = (ev) => {
    if (ev.type === 'start') $('#progress-text').textContent = `${ev.from} → ${ev.to}, ${ev.total}개 구간으로 시뮬레이션합니다…`;
    if (ev.type === 'step-start') $('#progress-text').textContent = `(${ev.index + 1}/${ev.total}) ${ev.from} ~ ${ev.to} 사이의 삶을 시뮬레이션하는 중…${ev.interventions ? ` ⚡ 신의 개입 ${ev.interventions}건` : ''}`;
    if (ev.type === 'step-done') {
      $('#progress-bar').style.width = `${((ev.index + 1) / ev.total) * 100}%`;
      $('#current-date').textContent = prettyDate(ev.currentDate);
      for (const e of ev.events) feed(`<b>${esc(e.date)}</b> ${esc(e.title)}`);
      if (ev.summary) feed(`<i>${esc(ev.summary)}</i>`);
    }
    if (ev.type === 'error') failed = ev.message;
  };

  try {
    if (local) {
      await local.advance(world.id, { targetDate, unit }, onEvent, running.signal);
      return;
    }
    const res = await fetch(`/api/worlds/${world.id}/advance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetDate, unit }),
      signal: running.signal,
    });
    if (!res.ok) throw new Error((await res.json()).error);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i).replace(/^data: /, '');
        buf = buf.slice(i + 2);
        onEvent(JSON.parse(line));
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') failed = e.message;
  } finally {
    running = null;
    $('#btn-run').hidden = false;
    $('#btn-stop').hidden = true;
    await openWorld(world.id);
    $('#progress-text').textContent = failed ? `⚠ 중단됨: ${failed} (현재 ${world.currentDate}까지 저장됨)` : `완료 — 현재 ${prettyDate(world.currentDate)}`;
  }
}

// ---------- 이벤트 바인딩 ----------
$('#world-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) openWorld(li.dataset.id);
});

$('#btn-sample').addEventListener('click', async () => {
  const w = await api('/worlds', { method: 'POST', body: { sample: true } });
  openWorld(w.id);
});

$('#btn-new-world').addEventListener('click', () => $('#dlg-world').showModal());
$('#dlg-world').addEventListener('close', async () => {
  if ($('#dlg-world').returnValue !== 'ok') return;
  const f = $('#world-form');
  const data = Object.fromEntries(new FormData(f));
  const w = await api('/worlds', { method: 'POST', body: { name: data.name, startDate: data.startDate, setting: data } });
  f.reset();
  openWorld(w.id);
  $('[data-tab=characters]').click();
});

$('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  $$('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  $$('.tab').forEach((t) => (t.hidden = t.id !== `tab-${b.dataset.tab}`));
});

$$('[data-jump]').forEach((b) => b.addEventListener('click', () => {
  $('#target-date').value = jump(world.currentDate, b.dataset.jump);
  runSimulation($('#target-date').value);
}));
$('#btn-run').addEventListener('click', () => runSimulation($('#target-date').value));
$('#btn-stop').addEventListener('click', () => running?.abort());
$('#btn-undo').addEventListener('click', async () => {
  if (!confirm('마지막 시뮬레이션 실행 이전 상태로 되돌릴까요?')) return;
  try {
    world = await api(`/worlds/${world.id}/undo`, { method: 'POST' });
    render();
    refreshWorldList();
  } catch (e) {
    toast(e.message);
  }
});

$('#timeline-filter').addEventListener('change', renderTimeline);
$('#timeline-importance').addEventListener('change', renderTimeline);

function showText(title, text) {
  $('#text-title').textContent = title;
  $('#text-body').textContent = text;
  $('#dlg-text').showModal();
}

$('#timeline').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-scene]');
  if (!b) return;
  const ev = world.events.find((x) => x.id === b.dataset.scene);
  if (ev.scene) return showText(`${ev.date} — ${ev.title}`, ev.scene);
  await withBusy(b, async () => {
    const { text } = await api(`/worlds/${world.id}/scene`, { method: 'POST', body: { eventId: ev.id } });
    ev.scene = text;
    showText(`${ev.date} — ${ev.title}`, text);
  });
});

$('#btn-chronicle').addEventListener('click', (e) => {
  const from = prompt('연대기 시작 날짜 (YYYY-MM-DD)', world.startDate);
  if (!from) return;
  const to = prompt('연대기 끝 날짜 (YYYY-MM-DD)', world.currentDate);
  if (!to) return;
  withBusy(e.target, async () => {
    const { text } = await api(`/worlds/${world.id}/chronicle`, { method: 'POST', body: { from, to } });
    showText(`연대기: ${from} ~ ${to}`, text);
  });
});

// 인물 편집
let editingId = null;
function openCharacterForm(c) {
  editingId = c?.id || null;
  const f = $('#char-form');
  f.reset();
  $('#char-form-title').textContent = c ? c.name : '새 인물';
  $('#btn-char-delete').hidden = !c?.id;
  const v = c || { personality: {}, status: {}, alive: true, traits: [], goals: [], skills: [], memories: [] };
  for (const k of ['name', 'gender', 'birthDate', 'occupation', 'location', 'appearance', 'values', 'fears', 'secrets', 'speechStyle', 'backstory', 'lifeSummary']) f[k].value = v[k] || '';
  f.traits.value = (v.traits || []).join(', ');
  f.skills.value = (v.skills || []).join(', ');
  f.goals.value = (v.goals || []).join('\n');
  for (const k of ['health', 'wealth', 'mood', 'social']) f[`status.${k}`].value = v.status?.[k] || '';
  f.alive.checked = v.alive !== false;
  $('#big-five').innerHTML = Object.entries(BIG_FIVE)
    .map(([k, l]) => `<label>${l} <input type="range" name="p.${k}" min="0" max="100" value="${v.personality?.[k] ?? 50}"><output>${v.personality?.[k] ?? 50}</output></label>`)
    .join('');
  $('#char-memories').innerHTML = (v.memories || []).slice().reverse().map((m) => `<li>${esc(m.date)} ${esc(m.text)}</li>`).join('') || '<li>아직 기억이 없습니다</li>';
  $('#dlg-character').showModal();
}

$('#btn-add-character').addEventListener('click', () => openCharacterForm(null));
$('#character-grid').addEventListener('click', (e) => {
  const edit = e.target.closest('[data-edit]');
  if (edit) openCharacterForm(world.characters.find((c) => c.id === edit.dataset.edit));
  const iv = e.target.closest('[data-interview]');
  if (iv) openInterview(iv.dataset.interview);
});

$('#dlg-character').addEventListener('close', async () => {
  if ($('#dlg-character').returnValue !== 'ok') return;
  const f = $('#char-form');
  const fd = new FormData(f);
  const data = { personality: {}, status: {} };
  for (const [k, val] of fd) {
    if (k.startsWith('p.')) data.personality[k.slice(2)] = Number(val);
    else if (k.startsWith('status.')) data.status[k.slice(7)] = val;
    else data[k] = val;
  }
  data.alive = f.alive.checked;
  data.goals = data.goals.split('\n').map((s) => s.trim()).filter(Boolean);
  try {
    if (editingId) await api(`/worlds/${world.id}/characters/${editingId}`, { method: 'PUT', body: data });
    else await api(`/worlds/${world.id}/characters`, { method: 'POST', body: data });
    openWorld(world.id);
  } catch (e) {
    toast(e.message);
  }
});

$('#btn-char-delete').addEventListener('click', async () => {
  if (!confirm('이 인물을 세계에서 지울까요? 관계도 함께 지워집니다.')) return;
  await api(`/worlds/${world.id}/characters/${editingId}`, { method: 'DELETE' });
  $('#dlg-character').close();
  openWorld(world.id);
});

$('#btn-gen-character').addEventListener('click', (e) => {
  const brief = $('#gen-brief').value.trim();
  if (!brief) return toast('어떤 인물을 원하는지 짧게 적어 주세요');
  withBusy(e.target, async () => {
    const c = await api(`/worlds/${world.id}/generate-character`, { method: 'POST', body: { brief } });
    delete c.id;
    openCharacterForm(c);
  });
});

// 슬라이더 값 표시
document.addEventListener('input', (e) => {
  if (e.target.type === 'range' && e.target.nextElementSibling?.tagName === 'OUTPUT') e.target.nextElementSibling.textContent = e.target.value;
});

// 인터뷰
function openInterview(id) {
  interviewCharId = id;
  interviewHistory = [];
  const c = world.characters.find((x) => x.id === id);
  $('#interview-title').textContent = `💬 ${c.name}와(과) 대화 — ${prettyDate(world.currentDate)}`;
  $('#interview-log').innerHTML = '<p class="hint">당신은 이 인물 앞에 나타난 낯선 존재입니다. 인물은 자기 성격과 기억대로 대답합니다.</p>';
  $('#dlg-interview').showModal();
}
async function ask() {
  const input = $('#interview-form').q;
  const q = input.value.trim();
  if (!q) return;
  input.value = '';
  const log = $('#interview-log');
  log.insertAdjacentHTML('beforeend', `<div class="q">${esc(q)}</div>`);
  await withBusy($('#btn-ask'), async () => {
    const { text } = await api(`/worlds/${world.id}/interview`, { method: 'POST', body: { characterId: interviewCharId, question: q, history: interviewHistory } });
    interviewHistory.push({ role: 'user', content: q }, { role: 'assistant', content: text });
    log.insertAdjacentHTML('beforeend', `<div class="a">${esc(text)}</div>`);
    log.scrollTop = log.scrollHeight;
  });
}
$('#btn-ask').addEventListener('click', ask);
$('#interview-form').q.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    ask();
  }
});

// 관계
const relForm = $('#rel-form');
function fillRelForm() {
  const r = world.relationships.find((x) => (x.a === relForm.a.value && x.b === relForm.b.value) || (x.b === relForm.a.value && x.a === relForm.b.value));
  relForm.type.value = r?.type || '';
  relForm.affinity.value = r?.affinity ?? 0;
  relForm.trust.value = r?.trust ?? 50;
  relForm.notes.value = r?.notes || '';
  $$('input[type=range]', relForm).forEach((x) => (x.nextElementSibling.textContent = x.value));
}
relForm.a.addEventListener('change', fillRelForm);
relForm.b.addEventListener('change', fillRelForm);
$('#rel-list').addEventListener('click', (e) => {
  const r = e.target.closest('.rel');
  if (!r) return;
  relForm.a.value = r.dataset.a;
  relForm.b.value = r.dataset.b;
  fillRelForm();
});
relForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api(`/worlds/${world.id}/relationships`, { method: 'PUT', body: Object.fromEntries(new FormData(relForm)) });
    openWorld(world.id);
  } catch (err) {
    toast(err.message);
  }
});
$('#btn-rel-delete').addEventListener('click', async () => {
  await api(`/worlds/${world.id}/relationships`, { method: 'DELETE', body: { a: relForm.a.value, b: relForm.b.value } });
  openWorld(world.id);
});

// 신의 개입
async function submitIntervention() {
  const f = $('#god-form');
  const data = Object.fromEntries(new FormData(f));
  data.targets = $$('#god-targets input:checked').map((x) => x.value);
  data.intensity = Number(data.intensity);
  await api(`/worlds/${world.id}/interventions`, { method: 'POST', body: data });
  f.title.value = '';
  f.description.value = '';
  return data;
}
$('#god-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await submitIntervention();
    openWorld(world.id);
  } catch (err) {
    toast(err.message);
  }
});
$('#btn-god-now').addEventListener('click', async () => {
  const f = $('#god-form');
  if (!f.reportValidity()) return;
  f.date.value = world.currentDate;
  try {
    await submitIntervention();
    await openWorld(world.id);
    $('[data-tab=timeline]').click();
    runSimulation(jump(world.currentDate, '7d'));
  } catch (err) {
    toast(err.message);
  }
});
$('#god-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-cancel-iv]');
  if (!b) return;
  await api(`/worlds/${world.id}/interventions/${b.dataset.cancelIv}`, { method: 'DELETE' });
  openWorld(world.id);
});

// 설정
$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target));
  try {
    world = await api(`/worlds/${world.id}`, { method: 'PATCH', body: { name: d.name, worldSummary: d.worldSummary, setting: d } });
    render();
    refreshWorldList();
  } catch (err) {
    toast(err.message);
  }
});
$('#btn-delete-world').addEventListener('click', async () => {
  if (!confirm(`"${world.name}" 세계를 완전히 삭제할까요?`)) return;
  await api(`/worlds/${world.id}`, { method: 'DELETE' });
  world = null;
  localStorage.removeItem('lastWorld');
  render();
  refreshWorldList();
});

// 앱에서는 파일 다운로드가 막혀 있어 JSON을 클립보드로 복사한다.
$('#btn-export').addEventListener('click', async (e) => {
  if (!local) return;
  e.preventDefault();
  try {
    await navigator.clipboard.writeText(JSON.stringify(await api(`/worlds/${world.id}/export`), null, 2));
    toast('세계 데이터(JSON)를 클립보드에 복사했습니다');
  } catch (err) {
    toast(`복사 실패: ${err.message}`);
  }
});

// 앱 설정 (API 키는 이 기기에만 저장)
function openAppSettings() {
  const f = $('#app-settings-form');
  const s = local.getSettings();
  f.apiKey.value = s.apiKey || '';
  f.model.value = s.model || 'claude-opus-5-5';
  f.effort.value = s.effort || 'medium';
  $('#dlg-app-settings').showModal();
}
$('#btn-app-settings').addEventListener('click', openAppSettings);
$('#dlg-app-settings').addEventListener('close', async () => {
  if ($('#dlg-app-settings').returnValue !== 'ok') return;
  local.saveSettings(Object.fromEntries(new FormData($('#app-settings-form'))));
  await loadInfo();
});

// ---------- 시작 ----------
const info = await loadInfo();
if (local && info.mock && !local.getSettings().dismissed) {
  local.saveSettings({ ...local.getSettings(), dismissed: true });
  openAppSettings();
}
await refreshWorldList();
const last = localStorage.getItem('lastWorld');
if (last) openWorld(last).catch(() => localStorage.removeItem('lastWorld'));
