import fs from 'node:fs/promises';
import path from 'node:path';

// 세계 하나당 <id>.json, 되돌리기 기록은 <id>.history.json
export function fileBackend(dir) {
  const worldPath = (id) => path.join(dir, `${id}.json`);
  const historyPath = (id) => path.join(dir, `${id}.history.json`);

  async function readJson(file) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  // 쓰기 도중 프로세스가 죽어도 파일이 깨지지 않도록 임시 파일에 쓴 뒤 교체한다.
  async function writeJson(file, data) {
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.rename(tmp, file);
  }

  return {
    async listWorlds() {
      await fs.mkdir(dir, { recursive: true });
      const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json') && !f.endsWith('.history.json'));
      return Promise.all(files.map((f) => readJson(path.join(dir, f))));
    },
    getWorld: (id) => readJson(worldPath(id)),
    putWorld: (id, w) => writeJson(worldPath(id), w),
    async deleteWorld(id) {
      await fs.rm(worldPath(id), { force: true });
      await fs.rm(historyPath(id), { force: true });
    },
    getHistory: (id) => readJson(historyPath(id)),
    putHistory: (id, h) => writeJson(historyPath(id), h),
  };
}
