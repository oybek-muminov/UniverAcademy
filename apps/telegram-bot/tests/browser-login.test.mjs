import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/returning-worker.mjs';
import { LoginMessageLifecycle } from '../src/login-message-lifecycle.mjs';
import { browserLoginUrl, BROWSER_LOGIN_TEXT, BROWSER_INVITE_TEXT, BROWSER_LOGIN_BUTTON } from '../src/browser-login.mjs';

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

test('the browser link must be the exact /telegram-link page on the Mini App origin', () => {
  assert.equal(browserLoginUrl(env('needs_clerk', { MINI_BROWSER_LINK_URL: BROWSER })), BROWSER);
  assert.equal(browserLoginUrl(env('needs_clerk', { MINI_BROWSER_LINK_URL: BROWSER }), TOKEN), BROWSER + '?invite=' + TOKEN);
  for (const value of [undefined, '', 'nope', 'http://mini.example.org/telegram-link', 'https://evil.example.org/telegram-link', 'https://mini.example.org/other',
    'https://mini.example.org/telegram-link?x=1', 'https://mini.example.org/telegram-link#x', 'https://u:p@mini.example.org/telegram-link', 'https://mini.example.org:444/telegram-link',
    'https://mini.example.org/telegram-link/', 'https://mini.example.org/telegram%2Dlink', 'https://mini.example.org\\telegram-link', 7, 'https://mini.example.org/telegram-link '])
    assert.equal(browserLoginUrl(env('needs_clerk', { MINI_BROWSER_LINK_URL: value })), null, String(value));
  assert.equal(browserLoginUrl({ MINI_BROWSER_LINK_URL: BROWSER }), null, 'needs the sign-in origin to compare with');
});
test('only a well-formed group invitation is copied into the link', () => {
  const e = env('needs_clerk', { MINI_BROWSER_LINK_URL: BROWSER });
  for (const bad of ['evil', 'grp_', 'grp_a b', 'grp_' + 'x'.repeat(61), 7, '', 'grp_a&x=1', 'grp_a#b']) assert.equal(browserLoginUrl(e, bad), null, String(bad));
});

test('/start of a new student: a normal-browser button, not the in-Telegram one', async () => {
  const body = await (await worker.fetch(post(start()), env('needs_clerk', { MINI_BROWSER_LINK_URL: BROWSER }))).json();
  assert.match(body.text, /xush kelibsiz/); assert.deepEqual(button(body), { text: BROWSER_LOGIN_BUTTON, url: BROWSER });
  assert(!('web_app' in button(body)));
});
test('without the setting, with a bad one, or for a registered student the buttons are exactly as before', async () => {
  for (const extra of [{}, { MINI_BROWSER_LINK_URL: 'https://evil.example.org/telegram-link' }, { MINI_BROWSER_LINK_URL: BROWSER + '?x=1' }]) {
    const body = await (await worker.fetch(post(start()), env('needs_clerk', extra))).json();
    assert.deepEqual(button(body), { text: 'Kirish / Ro‘yxatdan o‘tish', web_app: { url: SIGN_IN } });
  }
  const linked = await (await worker.fetch(post(start()), env('linked', { MINI_BROWSER_LINK_URL: BROWSER }))).json();
  assert.deepEqual(button(linked), { text: 'Kabinet', web_app: { url: CABINET } });
  const closed = await worker.fetch(post(start()), env('disabled', { MINI_BROWSER_LINK_URL: BROWSER }));
  assert.equal(await closed.text(), '');
});
test('a new student with a group invitation signs in through the browser and the invitation travels along', async () => {
  const body = await (await worker.fetch(post(start('/start ' + TOKEN)), invitePilot('needs_clerk'))).json();
  assert.equal(body.text, BROWSER_INVITE_TEXT); assert.deepEqual(button(body), { text: BROWSER_LOGIN_BUTTON, url: BROWSER + '?invite=' + TOKEN });
});
test('a registered student with a group invitation still opens it in the Mini App', async () => {
  const body = await (await worker.fetch(post(start('/start ' + TOKEN)), invitePilot('linked'))).json();
  assert.equal(button(body).text, 'Taklifni ochish'); assert.equal(new URL(button(body).web_app.url).searchParams.get('invite'), TOKEN);
});

function lifecycle(status, extra = {}) {
  let data; const sent = [];
  const storage = { get: async () => structuredClone(data), put: async (_, s) => { data = structuredClone(s); }, setAlarm: async () => {}, deleteAlarm: async () => {}, transaction: async fn => fn(storage) };
  const e = { ...env(status, extra), LOGIN_MESSAGE_TTL_SECONDS: '60' };
  const deliver = async (method, body) => { sent.push({ method, body }); return { kind: 'ok', result: method === 'sendMessage' ? { message_id: 5, chat: { id: body.chat_id } } : true }; };
  return { engine: new LoginMessageLifecycle(storage, e, deliver, () => 1_000_000), sent, state: () => data };
}
const ctx = { telegram_user_id: 42, update_id: 1 };
test('the tracked login message uses the browser button and is still cleaned up later', async () => {
  const h = lifecycle('needs_clerk', { MINI_BROWSER_LINK_URL: BROWSER }); await h.engine.start(ctx);
  const sent = h.sent.find(c => c.method === 'sendMessage').body;
  assert.equal(sent.text, BROWSER_LOGIN_TEXT); assert.deepEqual(button(sent), { text: BROWSER_LOGIN_BUTTON, url: BROWSER });
  assert.equal(h.state().receipts.length, 1);
});
test('the tracked login message is unchanged when the setting is absent, malformed or the person is staff', async () => {
  for (const extra of [{}, { MINI_BROWSER_LINK_URL: 'http://mini.example.org/telegram-link' }]) {
    const h = lifecycle('needs_clerk', extra); await h.engine.start(ctx);
    assert.deepEqual(button(h.sent.find(c => c.method === 'sendMessage').body), { text: 'Kirish / Ro‘yxatdan o‘tish', web_app: { url: SIGN_IN } });
  }
  const staff = lifecycle('linked', { MINI_BROWSER_LINK_URL: BROWSER, TELEGRAM_TEACHER_PILOT_ENABLED: 'true',
    TELEGRAM_PILOT_DIRECTORY: { readStaffCabinet: async () => 'teacher', recordPilotPrivateStart: async () => {} } });
  await staff.engine.start(ctx);
  assert.equal(button(staff.sent.find(c => c.method === 'sendMessage').body).url, 'https://ustoz.univeracademy.uz/');
});
