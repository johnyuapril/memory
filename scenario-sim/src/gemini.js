// Google Gemini API 연결. 무료 사용량이 있어 비용 없이 시험해 볼 때 쓴다.
// Claude와 같은 모양({ text, usage })으로 결과를 돌려준다.
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const GEMINI_DEFAULT_MODEL = 'gemini-flash-latest';

function friendlyError(status, body) {
  const msg = body?.error?.message || '';
  if (status === 400 && /API key/i.test(msg)) return new Error('Gemini API 키가 올바르지 않습니다. 설정에서 키를 확인하세요.');
  if (status === 403) return new Error(`Gemini API 키에 권한이 없습니다. ${msg}`);
  if (status === 404) return new Error(`Gemini 모델을 찾을 수 없습니다. 설정에서 "모델 목록 불러오기"로 다시 고르세요. ${msg}`);
  if (status === 429) return new Error('Gemini 무료 사용량 한도를 넘었습니다. 1분쯤 뒤에 다시 시도하거나, 시뮬레이션 단위를 크게(예: 3개월) 바꿔 호출 수를 줄이세요.');
  const e = new Error(`Gemini 오류 (${status}): ${msg}`);
  e.status = status;
  return e;
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('중지됨', 'AbortError'));
    });
  });

// 무료 사용량은 분당 요청 수가 적어서 429가 나면 몇 번 기다렸다가 다시 시도한다.
async function post(url, apiKey, body, signal) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new Error('Gemini API에 연결하지 못했습니다. 인터넷 연결을 확인하세요.');
    }
    if (res.ok) return res;
    const err = await res.json().catch(() => ({}));
    if ((res.status === 429 || res.status === 503) && attempt < 3) {
      await sleep(15000 * (attempt + 1), signal);
      continue;
    }
    throw friendlyError(res.status, err);
  }
}

// 응답이 길면 몇 분 걸리므로 스트리밍(SSE)으로 받아 연결이 끊기지 않게 한다.
async function readStream(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let finishReason = '';
  let blockReason = '';
  let usage = {};
  const handle = (chunk) => {
    if (chunk.promptFeedback?.blockReason) blockReason = chunk.promptFeedback.blockReason;
    if (chunk.usageMetadata) usage = chunk.usageMetadata;
    const cand = chunk.candidates?.[0];
    if (!cand) return;
    if (cand.finishReason) finishReason = cand.finishReason;
    for (const p of cand.content?.parts || []) if (p.text && !p.thought) text += p.text;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.startsWith('data:')) handle(JSON.parse(line.slice(5)));
    }
  }
  if (buf.trim().startsWith('data:')) handle(JSON.parse(buf.trim().slice(5)));
  return { text, finishReason, blockReason, usage };
}

export async function geminiGenerate({ apiKey, model, system, messages, maxTokens, schema, signal }) {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    generationConfig: {
      maxOutputTokens: maxTokens,
      ...(schema ? { responseMimeType: 'application/json', responseJsonSchema: schema } : {}),
    },
  };
  const url = `${BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  let res;
  try {
    res = await post(url, apiKey, body, signal);
  } catch (e) {
    // 스키마를 받아들이지 않는 모델이면 JSON 형식만 지정하고 스키마는 프롬프트로 넘긴다.
    if (schema && e.status === 400) {
      body.generationConfig = { maxOutputTokens: maxTokens, responseMimeType: 'application/json' };
      const last = body.contents.at(-1);
      last.parts[0].text += `\n\n다음 JSON 스키마를 따르는 JSON 객체 하나만 출력하라:\n${JSON.stringify(schema)}`;
      res = await post(url, apiKey, body, signal);
    } else {
      throw e;
    }
  }
  const out = await readStream(res);
  if (out.blockReason || ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'].includes(out.finishReason)) {
    throw new Error(`Gemini가 안전 정책으로 이 요청을 거절했습니다(${out.blockReason || out.finishReason}). 설정이나 개입 내용을 조정해 보세요.`);
  }
  if (out.finishReason === 'MAX_TOKENS') {
    throw new Error('응답이 너무 길어 잘렸습니다. 시뮬레이션 단위를 더 짧게(예: 1주) 바꿔 보세요.');
  }
  if (!out.text) throw new Error(`Gemini가 빈 응답을 보냈습니다 (${out.finishReason || '이유 불명'})`);
  return {
    text: out.text,
    usage: {
      input_tokens: out.usage.promptTokenCount || 0,
      output_tokens: (out.usage.candidatesTokenCount || 0) + (out.usage.thoughtsTokenCount || 0),
    },
  };
}

// 키로 쓸 수 있는 텍스트 생성 모델 목록. Flash 계열을 앞에 둔다.
export async function geminiListModels(apiKey) {
  let res;
  try {
    res = await fetch(`${BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': apiKey } });
  } catch {
    throw new Error('Gemini API에 연결하지 못했습니다. 인터넷 연결을 확인하세요.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw friendlyError(res.status, data);
  const skip = /image|tts|embedding|live|audio|native|robotics|computer|gemma|aqa|learnlm/i;
  return (data.models || [])
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => ({ id: m.name.replace(/^models\//, ''), name: m.displayName || m.name }))
    .filter((m) => m.id.startsWith('gemini') && !skip.test(m.id))
    .sort((a, b) => Number(b.id.includes('flash')) - Number(a.id.includes('flash')) || b.id.localeCompare(a.id));
}
