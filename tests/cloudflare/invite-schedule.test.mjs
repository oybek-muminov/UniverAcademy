import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { createInviteSchedule } from '../../runtime/cloudflare-invite-schedule.mjs';

test('disabled scheduled delivery reads only its own flag', async () => {
  const scheduled = createInviteSchedule();
  for (const value of [undefined, false, 'false', 'TRUE']) {
    const env = new Proxy({}, { get(_target, key) {
      assert.equal(key, 'UA_TELEGRAM_PILOT_DISPATCH_ENABLED');
      return value;
    } });
    await scheduled({}, env);
  }
});

test('a missing delivery Hyperdrive or unapproved Mini origin fails before reading the bot token', async () => {
  const scheduled = createInviteSchedule();
  const env = {
    UA_TELEGRAM_PILOT_DISPATCH_ENABLED: 'true', UA_CABINET_STUDENT_ORIGIN: 'https://mini.classroom.org',
    UA_ALLOWED_ORIGINS: '["https://mini.classroom.org"]',
    get UA_TELEGRAM_BOT_TOKEN() { assert.fail('premature bot secret read'); },
    get HYPERDRIVE() { assert.fail('registration database must stay isolated'); }
  };
  await assert.rejects(() => scheduled({}, env), /INVITE_DISPATCH_CONFIG_INVALID/);
  env.TEACHER_PILOT_HYPERDRIVE = { connectionString: 'postgres://fixture:fixture@local.example:5432/example' };
  env.UA_CABINET_STUDENT_ORIGIN = 'https://other.classroom.org';
  await assert.rejects(() => scheduled({}, env), /INVITE_DISPATCH_CONFIG_INVALID/);
});

test('the deployed module exposes a platform schedule, keeps registration fetch and publishes no dispatch route', async () => {
  const hook = registerHooks({ resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export class WorkerEntrypoint {}', shortCircuit: true };
    return next(specifier, context);
  } });
  try {
    const { default: worker } = await import('../../runtime/cloudflare-worker.mjs');
    await worker.scheduled({}, {});
    const origin = 'https://mini.classroom.org', api = 'https://api.classroom.org';
    const env = {
      UA_API_ORIGIN: api, UA_ALLOWED_ORIGINS: JSON.stringify([origin]),
      get UA_TELEGRAM_PILOT_DISPATCH_ENABLED() { assert.fail('HTTP must never invoke the schedule'); }
    };
    const response = await worker.fetch(new Request(api + '/api/v1/exams', {
      method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' }
    }), env);
    assert.equal(response.status, 204);
    const unavailable = await worker.fetch(new Request(api + '/api/v1/dispatch', { method: 'POST', headers: { origin } }), env);
    assert.equal(unavailable.status, 404);
  } finally { hook.deregister(); }
});
