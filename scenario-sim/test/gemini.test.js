import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { geminiGenerate, geminiListModels } from '../src/gemini.js';

const realFetch = globalThis.fetch;
afterEach(() => (globalThis.fetch = realFetch));

function sse(chunks) {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('스트리밍 응답을 이어 붙이고 사고(thought) 부분은 뺀다', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return sse([
      { candidates: [{ content: { parts: [{ text: '생각 중', thought: true }] } }] },
      { candidates: [{ content: { parts: [{ text: '{"a":' }] } }] },
      { candidates: [{ content: { parts: [{ text: '1}' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5 } },
    ]);
  };
  const res = await geminiGenerate({ apiKey: 'k', model: 'gemini-flash-latest', system: 'sys', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }, { role: 'user', content: 'q' }], maxTokens: 1000, schema: { type: 'object' } });
  assert.equal(res.text, '{"a":1}');
  assert.deepEqual(res.usage, { input_tokens: 100, output_tokens: 25 });
  assert.match(calls[0].url, /models\/gemini-flash-latest:streamGenerateContent\?alt=sse$/);
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'k');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.contents.map((c) => c.role), ['user', 'model', 'user']);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(body.generationConfig.responseJsonSchema, { type: 'object' });
});

test('스키마가 거부되면 스키마 없이 다시 요청한다', async () => {
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    if (bodies.length === 1) return new Response(JSON.stringify({ error: { message: 'Invalid JSON payload: responseJsonSchema' } }), { status: 400 });
    return sse([{ candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' }] }]);
  };
  const res = await geminiGenerate({ apiKey: 'k', model: 'm', system: 's', messages: [{ role: 'user', content: 'q' }], maxTokens: 10, schema: { type: 'object' } });
  assert.equal(res.text, '{}');
  assert.equal(bodies[1].generationConfig.responseJsonSchema, undefined);
  assert.match(bodies[1].contents[0].parts[0].text, /JSON 스키마/);
});

test('잘못된 키, 안전 차단, 잘림은 한국어 오류로 알려 준다', async () => {
  const opts = { apiKey: 'k', model: 'm', system: 's', messages: [{ role: 'user', content: 'q' }], maxTokens: 10 };
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'API key not valid. Please pass a valid API key.' } }), { status: 400 });
  await assert.rejects(geminiGenerate(opts), /Gemini API 키가 올바르지 않습니다/);
  globalThis.fetch = async () => sse([{ promptFeedback: { blockReason: 'SAFETY' } }]);
  await assert.rejects(geminiGenerate(opts), /안전 정책/);
  globalThis.fetch = async () => sse([{ candidates: [{ content: { parts: [{ text: '{"a' }] }, finishReason: 'MAX_TOKENS' }] }]);
  await assert.rejects(geminiGenerate(opts), /잘렸습니다/);
});

test('모델 목록은 텍스트 생성 모델만, Flash 먼저', async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({
      models: [
        { name: 'models/gemini-x-pro', displayName: 'Pro', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-x-flash', displayName: 'Flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-x-flash-image', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
      ],
    }));
  const models = await geminiListModels('k');
  assert.deepEqual(models.map((m) => m.id), ['gemini-x-flash', 'gemini-x-pro']);
});
