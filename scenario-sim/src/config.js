// 실행 환경(서버/모바일 앱)마다 다르게 채워지는 설정. 서버는 환경 변수, 앱은 사용자 설정 화면에서 넣는다.
export const config = {
  apiKey: '',
  model: 'claude-opus-5-5',
  effort: 'medium',
  forceMock: false,
  browser: false,
};

const listeners = new Set();

export function configure(patch) {
  Object.assign(config, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined && v !== null && v !== '')));
  if ('apiKey' in patch) config.apiKey = patch.apiKey || '';
  if ('forceMock' in patch) config.forceMock = Boolean(patch.forceMock);
  for (const fn of listeners) fn(config);
}

export function onConfigChange(fn) {
  listeners.add(fn);
}

export function isMock() {
  return config.forceMock || !config.apiKey;
}
