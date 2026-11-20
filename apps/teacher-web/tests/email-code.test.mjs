import test from 'node:test';
import assert from 'node:assert/strict';
import { requestTeacherEmailCode } from '../../mini-app/teacher-entrance/email-code.mjs';

test('desktop starts a fresh email challenge for the entered address in one SDK call', async () => {
  const signIn = { id: null, emailCode: { async sendCode(params) {
    assert.deepEqual(params, { emailAddress: 'teacher@example.org' });
    signIn.id = 'new-sign-in';
    return { error: null };
  } } };
  assert.equal(await requestTeacherEmailCode(signIn, 'teacher@example.org'), 'new-sign-in');
});
test('an unknown email and a factor unavailable for an account preserve the neutral challenge', async () => {
  const unknown = { errors: [{ code: 'form_identifier_not_found' }] };
  for (const sendCode of [async () => ({ error: unknown }), async () => { throw { code: 'factor_not_found' }; }]) {
    assert.equal(await requestTeacherEmailCode({ id: 'old', emailCode: { sendCode } }, 'teacher@example.org'), null);
  }
});
test('failed delivery requests and missing attempts keep the form available for retry', async () => {
  const limit = Object.assign(new Error(), { status: 429 });
  const offline = new TypeError('Network error');
  for (const sendCode of [async () => ({ error: limit }), async () => { throw offline; }, async () => ({ error: null })]) {
    await assert.rejects(requestTeacherEmailCode({ id: null, emailCode: { sendCode } }, 'teacher@example.org'));
  }
});
