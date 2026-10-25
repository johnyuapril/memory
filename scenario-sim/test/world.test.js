import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, applyStepResult, addIntervention, interventionsForStep, findRelationship } from '../src/world.js';
import { SAMPLE_WORLD } from '../src/sample.js';

test('시뮬레이션 결과 반영', () => {
  const w = createWorld(structuredClone(SAMPLE_WORLD));
  const iv = addIntervention(w, { description: '사무소에 화재', targets: ['토머스 하트'], date: '1820-05-10' });
  const step = { from: '1820-05-01', to: '1820-06-01' };
  assert.equal(interventionsForStep(w, step).length, 1);

  const created = applyStepResult(w, step, {
    newCharacters: [{ name: '제임스 오코너', occupation: '인쇄공', traits: ['급진파'] }],
    events: [
      { date: '1820-05-10', title: '화재', description: '불이 났다', involved: ['char_thomas', '에드워드 하트'], kind: 'god', importance: 5, interventionId: iv.id },
      { date: '1999-01-01', title: '범위 밖 날짜', description: '', involved: ['제임스 오코너', 'char_mary'], kind: 'life', importance: 2 },
    ],
    characterUpdates: [
      { id: 'char_thomas', status: { health: null, wealth: '파산 직전', mood: '절망', social: null }, personalityShift: { openness: 0, conscientiousness: 0, extraversion: 0, agreeableness: 0, neuroticism: 50 }, newMemories: [{ text: '사무소가 불탔다', importance: 5 }], lifeSummary: '불운한 해', died: false, addTraits: ['의심 많음'] },
    ],
    relationshipUpdates: [{ a: '제임스 오코너', b: 'char_mary', type: '동료', affinity: 30, trust: 60, notes: '', change: '인쇄소에서 친해짐' }],
    storylineUpdates: [{ id: null, title: '방화범은 누구인가', status: 'open', summary: '', involved: ['char_thomas'], beat: '화재 발생', resolution: null }],
    interventionOutcomes: [{ id: iv.id, outcome: '빚 문서가 사라졌다' }],
    worldSummary: '불황',
  });

  assert.equal(created.length, 2);
  assert.equal(created[1].date, '1820-06-01'); // 범위 밖 날짜는 구간 끝으로
  assert.equal(created[1].involved.length, 2); // 새 인물을 이름으로 참조
  const thomas = w.characters.find((c) => c.id === 'char_thomas');
  assert.equal(thomas.status.wealth, '파산 직전');
  assert.equal(thomas.status.health, '가벼운 통풍'); // null은 유지
  assert.equal(thomas.personality.neuroticism, 65); // 변화량은 ±10으로 제한
  assert.ok(thomas.traits.includes('의심 많음'));
  assert.equal(w.interventions[0].status, 'applied');
  assert.equal(w.interventions[0].outcome, '빚 문서가 사라졌다');
  assert.equal(w.storylines.length, 1);
  assert.equal(w.currentDate, '1820-06-01');
  const james = w.characters.find((c) => c.name === '제임스 오코너');
  assert.ok(james.isNpc);
  assert.equal(findRelationship(w, james.id, 'char_mary').affinity, 30);

  applyStepResult(w, { from: '1820-06-01', to: '1820-07-01' }, {
    storylineUpdates: [{ id: w.storylines[0].id, title: '방화범은 누구인가', status: 'resolved', summary: '', involved: [], beat: '범인 체포', resolution: '채권자의 소행' }],
  });
  assert.equal(w.storylines[0].status, 'resolved');
  assert.equal(w.storylines[0].resolvedAt, '1820-07-01');
});
