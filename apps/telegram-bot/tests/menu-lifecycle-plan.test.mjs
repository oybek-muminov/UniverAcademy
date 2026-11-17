import test from 'node:test';
import assert from 'node:assert/strict';
import { planMenuLifecycle } from '../src/menu-lifecycle-plan.mjs';
const base = { chatId: 42, navigation: 'needs_clerk', event: 'entry_expired',
  cabinetUrl: 'https://mini.univeracademy.uz/', signInUrl: 'https://mini.univeracademy.uz/sign-in',
  loginReceipt: { chatId: 42, messageId: 100 } };
for (const navigation of ['needs_clerk', 'linked', 'disabled']) {
  for (const event of ['entry_opened', 'entry_expired', 'entry_superseded', 'entry_completed']) {
    test(`${event} cleans old login message even when ${navigation}`, () => {
      const actions = planMenuLifecycle({ ...base, navigation, event });
      assert.deepEqual(actions[1], { method: 'deleteMessage', chat_id: 42, message_id: 100 });
      assert.equal(actions[0].menu_button.type, navigation === 'linked' ? 'web_app' : 'commands');
    });
  }
}
test('no guessed message ID without a saved send receipt', () => {
  assert.equal(planMenuLifecycle({ ...base, loginReceipt: undefined }).length, 1);
});
test('reconcile alone does not delete a newly sent login message', () => {
  assert.equal(planMenuLifecycle({ ...base, event: 'reconcile' }).length, 1);
});
test('late cleanup targets old receipt, never a newer message', () => {
  const next = { chatId: 42, messageId: 101 };
  assert.equal(planMenuLifecycle(base)[1].message_id, 100);
  assert.equal(next.messageId, 101);
});
test('reject cross-chat receipt', () => assert.throws(() => planMenuLifecycle({ ...base,
  loginReceipt: { chatId: 43, messageId: 100 } }), /INVALID_LOGIN_RECEIPT/));
test('unknown lookup state never grants menu access', () => assert.throws(() =>
  planMenuLifecycle({ ...base, navigation: 'unknown' }), /INVALID_MENU_STATE/));
