import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/returning-worker.mjs';
import { LoginMessageLifecycle } from '../src/login-message-lifecycle.mjs';
import { BROWSER_LOGIN_BUTTON, QUICK_REGISTER_TEXT, QUICK_REGISTER_BUTTON } from '../src/browser-login.mjs';

// Yangi o'quvchi uchun brauzerda kirish tugmasi. Sozlama bo'lmasa yoki xato bo'lsa eski tugma qoladi.
const SECRET = 'offline_browser_login_fixture', CABINET = 'https://mini.example.org/', SIGN_IN = 'https://mini.example.org/sign-in';
const BROWSER = 'https://mini.example.org/telegram-link', TOKEN = 'grp_' + 'a'.repeat(32);
const start = (text = '/start', id = 42) => ({ update_id: 7, message: { message_id: 8, from: { id, is_bot: false }, chat: { id, type: 'private' }, text } });
const post = update => new Request('https://bot.example.org/telegram/webhook', { method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': SECRET }, body: JSON.stringify(update) });
const env = (status, extra = {}) => ({ TELEGRAM_WEBHOOK_SECRET: SECRET, MINI_CABINET_URL: CABINET, MINI_SIGN_IN_URL: SIGN_IN,
  TELEGRAM_START_LOOKUP: { lookupTelegramStart: async () => ({ status }) }, ...extra });
const button = body => body.reply_markup.inline_keyboard[0][0];
const invitePilot = status => env(status, { MINI_BROWSER_LINK_URL: BROWSER, TELEGRAM_TEACHER_PILOT_ENABLED: 'true',
  TELEGRAM_PILOT_DIRECTORY: { recordPilotPrivateStart: async () => {}, readStaffCabinet: async () => null } });
function lifecycle(status, extra = {}) {
  let data; const sent = [];
  const storage = { get: async () => structuredClone(data), put: async (_, s) => { data = structuredClone(s); }, setAlarm: async () => {}, deleteAlarm: async () => {}, transaction: async fn => fn(storage) };
  const e = { ...env(status, extra), LOGIN_MESSAGE_TTL_SECONDS: '60' };
  const deliver = async (method, body) => { sent.push({ method, body }); return { kind: 'ok', result: method === 'sendMessage' ? { message_id: 5, chat: { id: body.chat_id } } : true }; };
  return { engine: new LoginMessageLifecycle(storage, e, deliver, () => 1_000_000), sent, state: () => data };
}
const ctx = { telegram_user_id: 42, update_id: 1 };
const QUICK = { TELEGRAM_QUICK_REGISTER: 'true', MINI_BROWSER_LINK_URL: BROWSER };
const quickButton = { text: QUICK_REGISTER_BUTTON, web_app: { url: CABINET } };

test('quick register: a new student gets one "Kabinetni ochish" Mini App button (instead of the browser button)', async () => {
  const body = await (await worker.fetch(post(start()), env('needs_clerk', QUICK))).json();
  assert.equal(body.text, QUICK_REGISTER_TEXT); assert.deepEqual(button(body), quickButton);
});
test('quick register: the tracked (Durable Object) message uses the same button and is cleaned up later', async () => {
  const h = lifecycle('needs_clerk', QUICK); await h.engine.start(ctx);
  const sent = h.sent.find(c => c.method === 'sendMessage').body;
  assert.equal(sent.text, QUICK_REGISTER_TEXT); assert.deepEqual(button(sent), quickButton);
  assert.equal(h.state().receipts.length, 1);
});
test('quick register: flag off or any value other than "true" brings back the previous button at once', async () => {
  for (const value of [undefined, 'false', 'TRUE', '1']) {
    const extra = { MINI_BROWSER_LINK_URL: BROWSER, ...(value === undefined ? {} : { TELEGRAM_QUICK_REGISTER: value }) };
    const body = await (await worker.fetch(post(start()), env('needs_clerk', extra))).json();
    assert.equal(button(body).text, BROWSER_LOGIN_BUTTON, String(value));
    const h = lifecycle('needs_clerk', extra); await h.engine.start(ctx);
    assert.equal(button(h.sent.find(c => c.method === 'sendMessage').body).text, BROWSER_LOGIN_BUTTON);
  }
});
test('quick register: registered students, staff-free linked path and closed accounts are unchanged', async () => {
  const linked = await (await worker.fetch(post(start()), env('linked', QUICK))).json();
  assert.deepEqual(button(linked), { text: 'Kabinet', web_app: { url: CABINET } });
  assert.equal(await (await worker.fetch(post(start()), env('disabled', QUICK))).text(), '');
  const h = lifecycle('linked', QUICK); await h.engine.start(ctx);
  assert.ok(!h.sent.some(c => c.method === 'sendMessage'));
});
test('quick register: a group invitation opens the cabinet in Telegram with the invitation kept', async () => {
  const pilot = env('needs_clerk', { ...QUICK, TELEGRAM_TEACHER_PILOT_ENABLED: 'true',
    TELEGRAM_PILOT_DIRECTORY: { recordPilotPrivateStart: async () => {}, readStaffCabinet: async () => null } });
  const body = await (await worker.fetch(post(start('/start ' + TOKEN)), pilot)).json();
  assert.equal(new URL(button(body).web_app.url).searchParams.get('invite'), TOKEN);
  assert.equal(new URL(button(body).web_app.url).origin + new URL(button(body).web_app.url).pathname, CABINET);
});
