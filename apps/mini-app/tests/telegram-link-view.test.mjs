import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';

// /telegram-link sahifasi: har bir bosqich ko'rinishi, xato matnlari va "jarayon davom etmoqda" belgisi.
const require = createRequire(import.meta.url);
const ts = createRequire(new URL('../../../package.json', import.meta.url))('typescript');
const hooks = registerHooks({ load(url, context, next) {
  if (url.endsWith('.tsx')) return { format: 'module', source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText, shortCircuit: true };
  return next(url, context);
} });
test.after(() => hooks.deregister());
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { TelegramLinkView } = await import('../src/telegram-link-view.tsx');
const { linkFailureMessage, browserLinkPending, BROWSER_LINK_MARKER } = await import('../src/telegram-link-page.tsx');
const { StudentApiError } = await import('../src/owner-client/student-client.ts');
const { StudentFailure } = await import('../src/transport.ts');
const view = props => renderToStaticMarkup(createElement(TelegramLinkView, { returnUrl: 'https://t.me/univeracademybot', ...props }));

test('har bosqich o‘z matni va tugmasini ko‘rsatadi', () => {
  assert.match(view({ phase: 'disabled' }), /hali yoqilmagan/);
  assert.match(view({ phase: 'signin', signIn: createElement('div', { id: 'clerk' }) }), /Google yoki email[\s\S]*id="clerk"/);
  const ready = view({ phase: 'ready' }); assert.match(ready, /Telegram bilan tasdiqlash/); assert.match(ready, /Boshqa hisob bilan kirish/);
  assert.match(view({ phase: 'working' }), /role="status"/);
  const done = view({ phase: 'done', returnUrl: 'https://t.me/univeracademybot?start=grp_x' });
  assert.match(done, /href="https:\/\/t\.me\/univeracademybot\?start=grp_x"/); assert.match(done, /\/start/);
  const failed = view({ phase: 'failed', message: 'Sabab shu.' }); assert.match(failed, /role="alert">Sabab shu\./); assert.match(failed, /Qayta urinish/);
  assert.match(view({ phase: 'failed' }), /Qaytadan urinib ko‘ring/);
});
test('sahifa hech qanday maxfiy qiymat, token yoki kod chiqarmaydi', () => {
  for (const phase of ['disabled', 'signin', 'ready', 'working', 'done', 'failed']) {
    const html = view({ phase, message: undefined }); assert(!/code=|verifier|client_secret|Bearer/i.test(html), phase);
  }
});
test('xato matnlari sababni aytadi va ichki kodni ko‘rsatmaydi', () => {
  const api = (status, code) => new StudentApiError(status, code, '');
  assert.match(linkFailureMessage(api(409, 'IDENTITY_LINK_CONFLICT')), /boshqa/);
  assert.match(linkFailureMessage(api(409, 'INIT_DATA_REPLAY')), /allaqachon ishlatilgan/);
  assert.match(linkFailureMessage(api(401, 'INIT_DATA_INVALID')), /eskirdi/);
  assert.match(linkFailureMessage(api(401, 'INIT_DATA_EXPIRED')), /eskirdi/);
  assert.match(linkFailureMessage(api(403, 'FORBIDDEN')), /o‘quvchi hisobi emas/);
  assert.match(linkFailureMessage(api(503, 'SERVICE_UNAVAILABLE')), /vaqtincha/);
  assert.match(linkFailureMessage(new StudentFailure('forbidden', 'FORBIDDEN')), /o‘quvchi hisobi emas/);
  for (const error of [api(500, 'WHATEVER'), new Error('secret'), null]) { const text = linkFailureMessage(error); assert.match(text, /Qaytadan urinib ko‘ring/); assert(!/WHATEVER|secret/.test(text)); }
});
test('"jarayon davom etmoqda" belgisi 30 daqiqadan keyin eskiradi va noto‘g‘ri qiymat hisobga olinmaydi', () => {
  const at = 1_700_000_000_000, store = value => ({ getItem: key => key === BROWSER_LINK_MARKER ? value : null });
  assert.equal(browserLinkPending(store(String(at)), at + 1000), true);
  assert.equal(browserLinkPending(store(String(at)), at + 30 * 60 * 1000), false);
  for (const value of [null, '', 'abc', '-5', '0']) assert.equal(browserLinkPending(store(value), at), false);
  assert.equal(browserLinkPending(store(String(at + 5000)), at), false);
  assert.equal(browserLinkPending({ getItem() { throw new Error('blocked'); } }, at), false);
});
