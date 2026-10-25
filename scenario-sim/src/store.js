// 저장소는 키-값 백엔드 위에 올라간다. 서버는 JSON 파일(store-fs.js), 모바일 앱은 IndexedDB(store-idb.js)를 쓴다.
const HISTORY_LIMIT = 10;

let backend = null;

export function setBackend(b) {
  backend = b;
}

function kv() {
  if (!backend) throw new Error('저장소가 설정되지 않았습니다');
  return backend;
}

export function newId(prefix) {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(5));
  return `${prefix}_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function checkId(id) {
  if (!/^[\w-]+$/.test(id)) throw new Error('잘못된 세계 ID');
  return id;
}

export async function listWorlds() {
  const worlds = await kv().listWorlds();
  return worlds
    .filter(Boolean)
    .map((w) => ({
      id: w.id,
      name: w.name,
      currentDate: w.currentDate,
      location: w.setting?.location || '',
      characterCount: w.characters?.length || 0,
      updatedAt: w.updatedAt,
    }))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function loadWorld(id) {
  const w = await kv().getWorld(checkId(id));
  if (!w) {
    const err = new Error('세계를 찾을 수 없습니다');
    err.status = 404;
    throw err;
  }
  return w;
}

export async function saveWorld(world) {
  world.updatedAt = new Date().toISOString();
  await kv().putWorld(checkId(world.id), world);
  return world;
}

export async function deleteWorld(id) {
  await kv().deleteWorld(checkId(id));
}

// 시뮬레이션 실행 전 상태를 저장해 두고 '되돌리기'로 복원할 수 있게 한다.
export async function pushSnapshot(world, label) {
  const history = (await kv().getHistory(checkId(world.id))) || [];
  history.push({ label, savedAt: new Date().toISOString(), world: structuredClone(world) });
  while (history.length > HISTORY_LIMIT) history.shift();
  await kv().putHistory(world.id, history);
}

export async function listSnapshots(id) {
  const history = (await kv().getHistory(checkId(id))) || [];
  return history.map((h, i) => ({ index: i, label: h.label, savedAt: h.savedAt, date: h.world.currentDate }));
}

export async function restoreSnapshot(id, index) {
  const history = (await kv().getHistory(checkId(id))) || [];
  const i = index ?? history.length - 1;
  const snap = history[i];
  if (!snap) throw new Error('되돌릴 기록이 없습니다');
  history.splice(i);
  await kv().putHistory(id, history);
  return saveWorld(snap.world);
}
