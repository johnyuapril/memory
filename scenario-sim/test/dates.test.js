import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addMonths, addDays, ageAt, planSteps, autoStep } from '../src/dates.js';

test('과거 날짜 계산', () => {
  assert.equal(addDays('1820-02-28', 1), '1820-02-29'); // 1820년은 윤년
  assert.equal(addMonths('1820-01-31', 1), '1820-02-29');
  assert.equal(addMonths('1821-01-31', 1), '1821-02-28');
  assert.equal(addMonths('1820-11-15', 3), '1821-02-15');
});

test('나이 계산', () => {
  assert.equal(ageAt('1802-02-14', '1820-05-01'), 18);
  assert.equal(ageAt('1802-02-14', '1822-02-13'), 19);
  assert.equal(ageAt('1802-02-14', '1822-07-03'), 20);
});

test('구간 나누기: 1820-05-01 → 1822-07-03 월 단위', () => {
  assert.equal(autoStep('1820-05-01', '1822-07-03'), 'month');
  const steps = planSteps('1820-05-01', '1822-07-03', 'month');
  assert.equal(steps[0].from, '1820-05-01');
  assert.equal(steps[0].to, '1820-06-01');
  assert.equal(steps.at(-1).to, '1822-07-03');
  assert.equal(steps.length, 27);
  for (let i = 1; i < steps.length; i++) assert.equal(steps[i].from, steps[i - 1].to);
});

test('역방향/같은 날짜는 빈 구간', () => {
  assert.deepEqual(planSteps('1820-05-01', '1820-05-01', 'week'), []);
});
