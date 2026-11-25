import test from 'node:test';
import assert from 'node:assert/strict';
import { isChannelRequired, CHANNEL_REQUIRED_CODE } from '../src/channel-required.ts';
import { createAtomicTelegramRuntime } from '../src/telegram-atomic-runtime.ts';
import { createTelegramReturnLaunch } from '../src/telegram-return-launch.ts';
import { StudentFailure } from '../src/transport.ts';

test('faqat "forbidden + CHANNEL_MEMBERSHIP_REQUIRED" kanal ekranini ochadi', () => {
  assert.equal(CHANNEL_REQUIRED_CODE, 'CHANNEL_MEMBERSHIP_REQUIRED');
  assert.equal(isChannelRequired(new StudentFailure('forbidden', 'CHANNEL_MEMBERSHIP_REQUIRED')), true);
  for (const other of [new StudentFailure('forbidden', 'ACCOUNT_DISABLED'), new StudentFailure('conflict', 'CHANNEL_MEMBERSHIP_REQUIRED'),
    new StudentFailure('temporary', 'SERVICE_UNAVAILABLE'), new Error('CHANNEL_MEMBERSHIP_REQUIRED'), null, undefined, 'x'])
    assert.equal(isChannelRequired(other), false);
});
test('return launch: channel_required alohida holat, "failed" emas', () => {
  const launch = createTelegramReturnLaunch(() => ({ initData: 'raw' }));
  launch.beginResume(); launch.channelRequired(); assert.equal(launch.phase(), 'channel_required');
});
function atomic(failure) {
  return createAtomicTelegramRuntime({ readLaunch: () => 'raw', identity: () => null, reverify: async () => null,
    connect: () => ({ auth: { login: async () => { throw failure; }, person: () => null, clear() {} }, port: {} }) });
}
test('atomic oqim: kanal shart -> channel_required, boshqa xato -> blocked', async () => {
  const a = atomic(new StudentFailure('forbidden', 'CHANNEL_MEMBERSHIP_REQUIRED')); await a.resume();
  assert.equal(a.snapshot().phase, 'channel_required'); assert.equal(a.snapshot().flow, null);
  const b = atomic(new StudentFailure('forbidden', 'ACCOUNT_DISABLED')); await b.resume(); assert.equal(b.snapshot().phase, 'blocked');
});
test('atomic oqim: yangi o‘quvchi (kabinet yo‘q) kanal ekranini ko‘rmaydi', async () => {
  const a = atomic(new StudentFailure('conflict', 'TELEGRAM_LINK_REQUIRED')); await a.resume(); assert.equal(a.snapshot().phase, 'choose');
});
