// 모바일 앱(웹뷰)용 저장소. localStorage는 용량이 작아 긴 시뮬레이션 기록을 담기 어려워 IndexedDB를 쓴다.
const DB_NAME = 'scenario-sim';
const STORES = ['worlds', 'history'];

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function idbBackend() {
  const dbp = open();
  const run = async (store, mode, fn) => {
    const db = await dbp;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('저장 실패 (저장 공간이 부족할 수 있습니다)'));
    });
  };
  return {
    listWorlds: () => run('worlds', 'readonly', (s) => s.getAll()),
    getWorld: async (id) => (await run('worlds', 'readonly', (s) => s.get(id))) ?? null,
    putWorld: (id, w) => run('worlds', 'readwrite', (s) => s.put(structuredClone(w), id)),
    async deleteWorld(id) {
      await run('worlds', 'readwrite', (s) => s.delete(id));
      await run('history', 'readwrite', (s) => s.delete(id));
    },
    getHistory: async (id) => (await run('history', 'readonly', (s) => s.get(id))) ?? null,
    putHistory: (id, h) => run('history', 'readwrite', (s) => s.put(h, id)),
  };
}
