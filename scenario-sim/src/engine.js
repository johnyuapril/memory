import * as llm from './llm.js';
import { simulateStepMock } from './mock.js';
import { applyStepResult, interventionsForStep } from './world.js';
import { planSteps, autoStep } from './dates.js';
import { saveWorld, pushSnapshot } from './store.js';

export const MOCK = process.env.SIM_MOCK === '1' || !(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

export function engineInfo() {
  return { mock: MOCK, model: MOCK ? 'mock' : llm.MODEL, effort: llm.EFFORT };
}

// targetDate까지 구간별로 시뮬레이션한다. 구간마다 저장하므로 중간에 멈춰도 그때까지의 결과는 남는다.
export async function advance(world, { targetDate, unit, onProgress = () => {}, isCancelled = () => false, signal }) {
  const stepUnit = unit && unit !== 'auto' ? unit : autoStep(world.currentDate, targetDate);
  const steps = planSteps(world.currentDate, targetDate, stepUnit);
  if (!steps.length) throw new Error('목표 날짜는 현재 날짜 이후여야 합니다');

  await pushSnapshot(world, `${world.currentDate} → ${targetDate} 실행 전`);
  onProgress({ type: 'start', total: steps.length, unit: stepUnit, from: world.currentDate, to: targetDate });

  for (let i = 0; i < steps.length; i++) {
    if (isCancelled()) {
      onProgress({ type: 'cancelled', at: world.currentDate });
      return world;
    }
    const step = steps[i];
    const interventions = interventionsForStep(world, step);
    onProgress({ type: 'step-start', index: i, total: steps.length, ...step, interventions: interventions.length });
    const result = MOCK ? await simulateStepMock(world, step, interventions) : await llm.simulateStep(world, step, interventions, { signal });
    const events = applyStepResult(world, step, result);
    await saveWorld(world);
    onProgress({ type: 'step-done', index: i, total: steps.length, ...step, events, summary: result.periodSummary || '', currentDate: world.currentDate });
  }
  onProgress({ type: 'done', currentDate: world.currentDate });
  return world;
}

const mockText = (title) => `(모의 모드) "${title}" — ANTHROPIC_API_KEY를 설정하면 Claude가 이 부분을 실제로 써 줍니다.`;

export async function scene(world, event) {
  return MOCK ? mockText(event.title) : llm.writeScene(world, event);
}

export async function chronicle(world, from, to) {
  return MOCK ? mockText(`${from} ~ ${to} 연대기`) : llm.writeChronicle(world, from, to);
}

export async function interview(world, characterId, question, history) {
  return MOCK ? mockText(question) : llm.interview(world, characterId, question, history);
}

export async function generateCharacter(world, brief) {
  if (MOCK) {
    return { name: '모의 인물', gender: '', birthDate: '', occupation: brief.slice(0, 20), traits: ['모의'], backstory: mockText(brief) };
  }
  return llm.generateCharacter(world, brief);
}
