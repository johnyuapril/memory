// 날짜는 모두 'YYYY-MM-DD' 문자열로 다룬다. 1800년대 같은 과거 날짜도 UTC 기준으로 안전하게 계산된다.

export function parseDate(s) {
  const m = /^(-?\d{1,6})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) throw new Error(`날짜 형식이 올바르지 않습니다: ${s} (YYYY-MM-DD)`);
  const d = new Date(Date.UTC(2000, Number(m[2]) - 1, Number(m[3])));
  d.setUTCFullYear(Number(m[1]));
  return d;
}

export function formatDate(d) {
  const y = d.getUTCFullYear();
  const yy = y < 0 ? '-' + String(-y).padStart(4, '0') : String(y).padStart(4, '0');
  return `${yy}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function isValidDate(s) {
  try { parseDate(s); return true; } catch { return false; }
}

export function compareDates(a, b) {
  return parseDate(a).getTime() - parseDate(b).getTime();
}

export function addDays(s, n) {
  const d = parseDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return formatDate(d);
}

// 월 단위 이동. 1월 31일 + 1개월은 2월 말일로 맞춘다.
export function addMonths(s, n) {
  const d = parseDate(s);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(2000, d.getUTCMonth() + 1, 0));
  last.setUTCFullYear(d.getUTCFullYear(), d.getUTCMonth() + 1, 0);
  d.setUTCDate(Math.min(day, last.getUTCDate()));
  return formatDate(d);
}

export function daysBetween(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / 86400000);
}

export function ageAt(birthDate, onDate) {
  if (!birthDate || !isValidDate(birthDate) || !isValidDate(onDate)) return null;
  const b = parseDate(birthDate);
  const d = parseDate(onDate);
  let age = d.getUTCFullYear() - b.getUTCFullYear();
  if (d.getUTCMonth() < b.getUTCMonth() || (d.getUTCMonth() === b.getUTCMonth() && d.getUTCDate() < b.getUTCDate())) age--;
  return age;
}

export const STEP_UNITS = {
  day: { label: '하루', advance: (s) => addDays(s, 1) },
  week: { label: '1주', advance: (s) => addDays(s, 7) },
  month: { label: '1개월', advance: (s) => addMonths(s, 1) },
  season: { label: '3개월', advance: (s) => addMonths(s, 3) },
  halfyear: { label: '6개월', advance: (s) => addMonths(s, 6) },
};

// 기간이 길수록 큰 단위를 써서 호출 수를 적당히 유지한다.
export function autoStep(from, to) {
  const days = daysBetween(from, to);
  if (days <= 14) return 'day';
  if (days <= 120) return 'week';
  if (days <= 365 * 3) return 'month';
  if (days <= 365 * 10) return 'season';
  return 'halfyear';
}

// from 다음 날부터 to까지를 단위별 구간으로 나눈다. 각 구간은 { from, to } (from은 직전 시점, to는 구간 끝).
export function planSteps(from, to, unit) {
  if (compareDates(to, from) <= 0) return [];
  const step = STEP_UNITS[unit] || STEP_UNITS[autoStep(from, to)];
  const out = [];
  let cur = from;
  while (compareDates(cur, to) < 0) {
    let next = step.advance(cur);
    if (compareDates(next, to) > 0) next = to;
    out.push({ from: cur, to: next });
    cur = next;
  }
  return out;
}
