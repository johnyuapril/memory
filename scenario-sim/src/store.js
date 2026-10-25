import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = process.env.SIM_DATA_DIR || path.join(process.cwd(), 'data', 'worlds');
const HISTORY_LIMIT = 10;

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
}

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

function worldPath(id) {
  if (!/^[\w-]+$/.test(id)) throw new Error('잘못된 세계 ID');
  return path.join(DATA_DIR, `${id}.json`);
}

function historyPath(id) {
  return worldPath(id).replace(/\.json$/, '.history.json');
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}

// 쓰기 도중 프로세스가 죽어도 파일이 깨지지 않도록 임시 파일에 쓴 뒤 교체한다.
async function writeJson(file, data) {
  await ensureDir();
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

export async function listWorlds() {
  await ensureDir();
  const files = (await fs.readdir(DATA_DIR)).filter((f) => f.endsWith('.json') && !f.endsWith('.history.json'));
  const worlds = await Promise.all(files.map((f) => readJson(path.join(DATA_DIR, f), null)));
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
  const w = await readJson(worldPath(id), null);
  if (!w) {
    const err = new Error('세계를 찾을 수 없습니다');
    err.status = 404;
    throw err;
  }
  return w;
}

export async function saveWorld(world) {
  world.updatedAt = new Date().toISOString();
  await writeJson(worldPath(world.id), world);
  return world;
}

export async function deleteWorld(id) {
  await fs.rm(worldPath(id), { force: true });
  await fs.rm(historyPath(id), { force: true });
}

// 시뮬레이션 실행 전 상태를 저장해 두고 '되돌리기'로 복원할 수 있게 한다.
export async function pushSnapshot(world, label) {
  const history = await readJson(historyPath(world.id), []);
  history.push({ label, savedAt: new Date().toISOString(), world: structuredClone(world) });
  while (history.length > HISTORY_LIMIT) history.shift();
  await writeJson(historyPath(world.id), history);
}

export async function listSnapshots(id) {
  const history = await readJson(historyPath(id), []);
  return history.map((h, i) => ({ index: i, label: h.label, savedAt: h.savedAt, date: h.world.currentDate }));
}

export async function restoreSnapshot(id, index) {
  const history = await readJson(historyPath(id), []);
  const i = index ?? history.length - 1;
  const snap = history[i];
  if (!snap) throw new Error('되돌릴 기록이 없습니다');
  history.splice(i);
  await writeJson(historyPath(id), history);
  return saveWorld(snap.world);
}
