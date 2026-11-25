import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/returning-worker.mjs';
import { LoginMessageLifecycle } from '../src/login-message-lifecycle.mjs';

// Kanal a'zoligi: yangi o'quvchi / a'zo / a'zo emas / xodim / Telegram xatosi.
// Telegram va baza soxta; hech qanday haqiqiy tarmoq so'rovi yo'q.
const SECRET = 'offline_channel_gate_fixture';
const TOKEN = '123456:' + 'A'.repeat(30);
const CABINET = 'https://mini.example.org/', SIGN_IN = 'https://mini.example.org/sign-in';
const CHANNEL_URL = 'https://t.me/PhysicsHubUZ';
const gateEnv = { UA_CHANNEL_GATE_ENABLED: 'true', UA_REQUIRED_CHANNEL: '@PhysicsHubUZ', UA_REQUIRED_CHANNEL_URL: CHANNEL_URL };
const start = (id = 42) => ({ update_id: 7, message: { message_id: 8, from: { id, is_bot: false }, chat: { id, type: 'private' }, text: '/start' } });
const press = (id = 42, extra = {}) => ({ update_id: 9, callback_query: { id: 'cb1', from: { id, is_bot: false }, data: 'channel_check',
  message: { message_id: 3, chat: { id, type: 'private' } }, ...extra } });
const post = update => new Request('https://bot.example.org/telegram/webhook', { method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': SECRET }, body: JSON.stringify(update) });

let telegram, native = globalThis.fetch;
// telegram.reply: 'member' | 'left' | 'kicked' | 'restricted-out' | 'api-error' | 'down' | 'throw'
beforeEach(() => {
  telegram = { reply: 'member', getChatMember: [], other: [] };
  globalThis.fetch = async (url, init) => {
    const method = String(url).split('/').pop();
    const body = JSON.parse(init.body);
    if (method !== 'getChatMember') { telegram.other.push({ method, body }); return Response.json({ ok: true, result: true }); }
    telegram.getChatMember.push(body);
    const r = telegram.reply;
    if (r === 'throw') throw new Error('network');
    if (r === 'down') return new Response('bad gateway', { status: 502 });
    if (r === 'api-error') return Response.json({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }, { status: 400 });
    if (r === 'restricted-out') return Response.json({ ok: true, result: { status: 'restricted', is_member: false } });
    return Response.json({ ok: true, result: { status: r === 'member' ? 'member' : r } });
  };
});
after(() => { globalThis.fetch = native; });

function env({ status = 'linked', staff = null, gate = gateEnv } = {}) {
  return { TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_BOT_TOKEN: TOKEN, ...gate,
    MINI_CABINET_URL: CABINET, MINI_SIGN_IN_URL: SIGN_IN,
    TELEGRAM_START_LOOKUP: { lookupTelegramStart: async () => ({ status }) },
    ...(staff ? { TELEGRAM_TEACHER_PILOT_ENABLED: 'true', TELEGRAM_PILOT_DIRECTORY: { readStaffCabinet: async () => staff, recordPilotPrivateStart: async () => {} } } : {}) };
}
const prompt = { method: 'sendMessage', chat_id: 42,
  text: 'Kabinetga kirish uchun avval rasmiy kanalimizga a‘zo bo‘ling, so‘ng “Tekshirish” tugmasini bosing.',
  reply_markup: { inline_keyboard: [[{ text: 'Kanalga o‘tish', url: CHANNEL_URL }], [{ text: 'Tekshirish', callback_data: 'channel_check' }]] } };
const button = body => body.reply_markup.inline_keyboard[0][0];

// ---- /start ----
test('yangi o‘quvchi: kanal so‘ralmaydi va Telegram\'ga so‘rov ketmaydi', async () => {
  telegram.reply = 'left';
  const body = await (await worker.fetch(post(start()), env({ status: 'needs_clerk' }))).json();
  assert.equal(button(body).text, 'Kirish / Ro‘yxatdan o‘tish');
  assert.equal(telegram.getChatMember.length, 0);
});
test('kabineti bor va kanalga a‘zo: odatdagi "Kabinet" tugmasi', async () => {
  const body = await (await worker.fetch(post(start()), env())).json();
  assert.equal(button(body).text, 'Kabinet'); assert.equal(button(body).web_app.url, CABINET);
  assert.deepEqual(telegram.getChatMember, [{ chat_id: '@PhysicsHubUZ', user_id: 42 }]);
});
for (const reply of ['left', 'kicked', 'restricted-out'])
  test(`kabineti bor, kanalda emas (${reply}): kirish to‘xtaydi, "Kanalga o‘tish" va "Tekshirish" chiqadi`, async () => {
    telegram.reply = reply;
    assert.deepEqual(await (await worker.fetch(post(start()), env())).json(), prompt);
  });
test('xodim (ustoz) kanalda bo‘lmasa ham to‘xtatilmaydi', async () => {
  telegram.reply = 'left';
  const body = await (await worker.fetch(post(start()), env({ staff: 'teacher' }))).json();
  assert.equal(button(body).url, 'https://ustoz.univeracademy.uz/');
  assert.ok(!JSON.stringify(body).includes('channel_check'));
});
for (const reply of ['down', 'api-error', 'throw'])
  test(`Telegram xatosi (${reply}): o‘quvchi kiritiladi`, async () => {
    telegram.reply = reply;
    const body = await (await worker.fetch(post(start()), env())).json();
    assert.equal(button(body).text, 'Kabinet');
  });
for (const [label, gate] of [['o‘chiq', {}], ['kanal nomi xato', { ...gateEnv, UA_REQUIRED_CHANNEL: 'not a channel' }],
  ['havola xato', { ...gateEnv, UA_REQUIRED_CHANNEL_URL: 'http://evil.example/x' }], ['yoqilmagan', { ...gateEnv, UA_CHANNEL_GATE_ENABLED: 'false' }]])
  test(`tekshiruv ${label}: hech kim to‘xtatilmaydi, Telegram'ga so‘rov yo‘q`, async () => {
    telegram.reply = 'left';
    const body = await (await worker.fetch(post(start()), env({ gate }))).json();
    assert.equal(button(body).text, 'Kabinet'); assert.equal(telegram.getChatMember.length, 0);
  });

// ---- "Tekshirish" tugmasi ----
test('Tekshirish: hali a‘zo emas — ogohlantirish oynasi, kabinet berilmaydi', async () => {
  telegram.reply = 'left';
  const body = await (await worker.fetch(post(press()), env())).json();
  assert.equal(body.method, 'answerCallbackQuery'); assert.equal(body.callback_query_id, 'cb1'); assert.equal(body.show_alert, true);
  assert.ok(!body.reply_markup);
});
test('Tekshirish: a‘zo bo‘ldi — "Kabinet" tugmasi beriladi', async () => {
  const body = await (await worker.fetch(post(press()), env())).json();
  assert.equal(body.method, 'sendMessage'); assert.equal(button(body).web_app.url, CABINET);
  assert.deepEqual(telegram.other, [{ method: 'answerCallbackQuery', body: { callback_query_id: 'cb1' } }]);
});
test('Tekshirish: Telegram xatosi — o‘quvchi kiritiladi', async () => {
  telegram.reply = 'down';
  assert.equal(button(await (await worker.fetch(post(press()), env())).json()).text, 'Kabinet');
});
test('Tekshirish: yangi o‘quvchiga kabinet emas, kirish tugmasi', async () => {
  telegram.reply = 'left';
  const body = await (await worker.fetch(post(press()), env({ status: 'needs_clerk' }))).json();
  assert.equal(button(body).web_app.url, SIGN_IN); assert.equal(telegram.getChatMember.length, 0);
});
test('Tekshirish: yopilgan hisobga hech narsa ochilmaydi', async () => {
  const body = await (await worker.fetch(post(press()), env({ status: 'disabled' }))).json();
  assert.equal(body.method, 'answerCallbackQuery'); assert.ok(!body.reply_markup); assert.equal(telegram.getChatMember.length, 0);
});
test('Tekshirish: xodimga ustoz kabineti tugmasi', async () => {
  telegram.reply = 'left';
  assert.equal(button(await (await worker.fetch(post(press()), env({ staff: 'admin' }))).json()).url, 'https://ustoz.univeracademy.uz/admin');
});
test('boshqa yoki noto‘g‘ri tugma/chat e‘tiborsiz qoldiriladi', async () => {
  for (const update of [press(42, { data: 'other' }), press(42, { message: { message_id: 3, chat: { id: 99, type: 'private' } } }),
    press(42, { message: { message_id: 3, chat: { id: 42, type: 'group' } } }), press(42, { from: { id: 42, is_bot: true } })]) {
    const response = await worker.fetch(post(update), env());
    assert.equal(await response.text(), '');
  }
  assert.equal(telegram.getChatMember.length, 0);
});

// ---- bot ichidagi xabar hayoti (asosiy ishlaydigan yo'l) ----
function lifecycle(options) {
  let data; const sent = [];
  const storage = { get: async () => structuredClone(data), put: async (_, s) => { data = structuredClone(s); },
    setAlarm: async () => {}, deleteAlarm: async () => {}, transaction: async fn => fn(storage) };
  const e = { ...env(options), LOGIN_MESSAGE_TTL_SECONDS: '60' };
  const deliver = async (method, body) => { sent.push({ method, body }); return { kind: 'ok', result: method === 'sendMessage' ? { message_id: 5, chat: { id: body.chat_id } } : true }; };
  return { engine: new LoginMessageLifecycle(storage, e, deliver, () => 1_000_000), sent, state: () => data };
}
const ctx = { telegram_user_id: 42, update_id: 1 };
test('xabar hayoti: kanalda emas o‘quvchiga bitta xabar, o‘chirib tashlanmaydi', async () => {
  telegram.reply = 'left'; const h = lifecycle();
  await h.engine.start(ctx); await h.engine.drain();
  const messages = h.sent.filter(c => c.method === 'sendMessage');
  assert.equal(messages.length, 1); assert.deepEqual(messages[0].body, { chat_id: 42, text: prompt.text, reply_markup: prompt.reply_markup });
  assert.equal(h.sent.filter(c => c.method === 'deleteMessage').length, 0); assert.equal(h.state().receipts.length, 0);
});
test('xabar hayoti: a‘zo o‘quvchiga xabar yuborilmaydi', async () => {
  const h = lifecycle(); await h.engine.start(ctx);
  assert.equal(h.sent.filter(c => c.method === 'sendMessage').length, 0);
});
test('xabar hayoti: yangi o‘quvchiga kirish tugmasi, kanal so‘ralmaydi', async () => {
  telegram.reply = 'left'; const h = lifecycle({ status: 'needs_clerk' }); await h.engine.start(ctx);
  assert.ok(h.sent.some(c => c.method === 'sendMessage' && JSON.stringify(c.body).includes('sign-in')));
  assert.equal(telegram.getChatMember.length, 0);
});
test('xabar hayoti: xodim kanalda bo‘lmasa ham ustoz kabineti tugmasini oladi', async () => {
  telegram.reply = 'left'; const h = lifecycle({ staff: 'teacher' }); await h.engine.start(ctx);
  const body = h.sent.find(c => c.method === 'sendMessage').body;
  assert.ok(!JSON.stringify(body).includes('channel_check')); assert.equal(telegram.getChatMember.length, 0);
});
test('xabar hayoti: Telegram xatosida o‘quvchi to‘xtatilmaydi (xabar yo‘q)', async () => {
  telegram.reply = 'throw'; const h = lifecycle(); await h.engine.start(ctx);
  assert.equal(h.sent.filter(c => c.method === 'sendMessage').length, 0);
});
