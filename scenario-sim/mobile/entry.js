// 안드로이드 앱(웹뷰) 안에서 서버 없이 돌아가는 API. public/app.js는 window.localApi가 있으면 fetch 대신 이것을 쓴다.
import { configure } from '../src/config.js';
import { setBackend } from '../src/store.js';
import { idbBackend } from '../src/store-idb.js';
import { handleApi, startAdvance } from '../src/api.js';
import { GEMINI_DEFAULT_MODEL, geminiListModels } from '../src/gemini.js';

const SETTINGS_KEY = 'scenario-sim-settings';

function getSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch {
    return {};
  }
}

// 두 제공자의 키를 따로 저장해 두고, 고른 쪽의 키와 모델만 엔진에 넘긴다.
function apply(s) {
  const gemini = s.provider === 'gemini';
  configure({
    provider: gemini ? 'gemini' : 'anthropic',
    apiKey: (gemini ? s.geminiKey : s.apiKey) || '',
    model: gemini ? s.geminiModel || GEMINI_DEFAULT_MODEL : s.model || 'claude-opus-5-5',
    effort: s.effort,
    browser: true,
  });
}

setBackend(idbBackend());
apply(getSettings());

window.localApi = {
  async request(method, path, body) {
    const { data } = await handleApi(method, path, body || {});
    // 서버와 같이 복사본을 돌려줘야 UI가 저장된 상태를 실수로 바꾸지 않는다.
    return structuredClone(data);
  },
  async advance(id, input, onEvent, signal) {
    const run = await startAdvance(id, input);
    await run((ev) => onEvent(structuredClone(ev)), { isCancelled: () => signal.aborted, signal });
  },
  getSettings,
  listGeminiModels: geminiListModels,
  saveSettings(s) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    apply(s);
  },
};
