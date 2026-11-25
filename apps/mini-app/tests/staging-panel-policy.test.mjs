import test from 'node:test';
import assert from 'node:assert/strict';
import { isTransient, failureOutcome, remainingSeconds, resyncDelay, clockText, MAX_RESYNC_ATTEMPTS } from '../src/staging-panel-policy.mjs';

// 2) Internet uzilsa javob berish qulflanmaydi; boshqa xatoda avval holat qayta o'qiladi.
test('tarmoq xatosida javob berish ochiq qoladi, lekin saqlangan holat o‘zi qayta o‘qiladi', () => {
  for (const kind of ['temporary', 'offline', 'limited']) {
    assert.equal(isTransient(kind), true);
    assert.deepEqual(failureOutcome(kind, true), { scopeLost: false, lockAnswers: false, resync: true });
  }
});
test('holat o‘zgargan xatolarda (conflict, validation, protocol) javob berish qayta o‘qilguncha qulflanadi', () => {
  for (const kind of ['conflict', 'validation', 'protocol']) {
    assert.equal(isTransient(kind), false);
    assert.deepEqual(failureOutcome(kind, true), { scopeLost: false, lockAnswers: true, resync: true });
  }
});
test('ruxsat yo‘qolsa (forbidden, missing) himoyalangan ma‘lumot yashiriladi va haqiqiy holat qayta o‘qiladi', () => {
  for (const onAttempt of [true, false]) for (const kind of ['forbidden', 'missing'])
    assert.deepEqual(failureOutcome(kind, onAttempt), { scopeLost: true, lockAnswers: false, resync: false });
});
test('test ekranida bo‘lmasa, oddiy xatoda hech narsa qulflanmaydi va qayta o‘qish boshlanmaydi', () => {
  for (const kind of ['temporary', 'conflict', 'validation'])
    assert.deepEqual(failureOutcome(kind, false), { scopeLost: false, lockAnswers: false, resync: false });
});

// Avtomatik qayta o'qish cheklangan: server ishlamasa cheksiz so'rov yubormaydi.
test('avtomatik qayta o‘qish 5 martadan keyin to‘xtaydi', () => {
  assert.equal(resyncDelay(0), 1500);
  for (let n = 1; n < MAX_RESYNC_ATTEMPTS; n++) assert.equal(resyncDelay(n), 4000);
  for (const n of [MAX_RESYNC_ATTEMPTS, 6, 100]) assert.equal(resyncDelay(n), null);
  for (const bad of [-1, 1.5, NaN, undefined, '1']) assert.equal(resyncDelay(bad), null);
});

// 4) Soat server vaqtiga tayanadi, telefon soatiga emas.
const T0 = Date.UTC(2026, 10, 25, 10, 0, 0);
const deadlineAt = new Date(T0 + 90 * 60000).toISOString();
test('qolgan vaqt = tugash - server vaqti - o‘tgan vaqt', () => {
  assert.equal(remainingSeconds({ deadlineAt, serverNow: T0, receivedAt: 1000, now: 1000 }), 5400);
  assert.equal(remainingSeconds({ deadlineAt, serverNow: T0, receivedAt: 1000, now: 1000 + 61000 }), 5339);
  assert.equal(remainingSeconds({ deadlineAt, serverNow: T0, receivedAt: 1000, now: 1000 + 90 * 60000 }), 0);
});
test('telefon soati noto‘g‘ri bo‘lsa ham qolgan vaqt o‘zgarmaydi', () => {
  const real = Date.now;
  try {
    for (const skew of [-3 * 3600e3, 0, 7200e3]) {
      Date.now = () => T0 + skew;
      assert.equal(remainingSeconds({ deadlineAt, serverNow: T0, receivedAt: 5000, now: 5000 + 30000 }), 5370);
    }
  } finally { Date.now = real; }
});
test('vaqt tugagach manfiy bo‘lmaydi, noto‘g‘ri ma‘lumotda null', () => {
  assert.equal(remainingSeconds({ deadlineAt, serverNow: T0, receivedAt: 0, now: 10 ** 9 }), 0);
  assert.equal(remainingSeconds({ deadlineAt, serverNow: T0, receivedAt: 100, now: 50 }), 5400);
  for (const bad of [{ deadlineAt: 'x' }, { serverNow: NaN }, { receivedAt: undefined }, { now: Infinity }])
    assert.equal(remainingSeconds({ deadlineAt, serverNow: T0, receivedAt: 0, now: 0, ...bad }), null);
});
test('soat matni MM:SS, 60 daqiqadan oshsa ham', () => {
  assert.equal(clockText(5400), '90:00'); assert.equal(clockText(65), '01:05'); assert.equal(clockText(0), '00:00'); assert.equal(clockText(-4), '00:00');
});
