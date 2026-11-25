import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';

// Telegram ichida Google tugmasi yashirinadi (Google Telegram oynasini rad etadi: 403 disallowed_useragent);
// oddiy brauzerda hech narsa o'zgarmaydi.
const require = createRequire(import.meta.url);
const ts = createRequire(new URL('../../../package.json', import.meta.url))('typescript');
const hooks = registerHooks({ load(url, context, next) {
  if (url.endsWith('.tsx')) return { format: 'module', source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText, shortCircuit: true };
  return next(url, context);
} });
test.after(() => hooks.deregister());
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { SignInCard, telegramSignInAppearance, TELEGRAM_SIGN_IN_HINT } = await import('../src/sign-in-card.tsx');

function render(inTelegram) {
  const seen = [];
  const Fake = props => { seen.push(props); return createElement('div', { id: 'clerk-sign-in' }); };
  const html = renderToStaticMarkup(createElement(SignInCard, { inTelegram, callbackUrl: 'https://mini.example.org/auth/callback', Component: Fake }));
  return { html, props: seen[0] };
}

test('Telegram ichida: Google tugmasi va ajratgich yashiriladi, tushuntirish ko‘rsatiladi', () => {
  const { html, props } = render(true);
  assert.equal(props.appearance, telegramSignInAppearance);
  for (const key of ['socialButtonsRoot', 'socialButtons', 'dividerRow']) assert.deepEqual(props.appearance.elements[key], { display: 'none' });
  assert(html.includes(TELEGRAM_SIGN_IN_HINT));
  assert.match(TELEGRAM_SIGN_IN_HINT, /Google/); assert.match(TELEGRAM_SIGN_IN_HINT, /kod/);
});

test('oddiy brauzerda: ko‘rinish o‘zgarmaydi (Google tugmasi qoladi, tushuntirish yo‘q)', () => {
  const { html, props } = render(false);
  assert(!('appearance' in props));
  assert(!html.includes(TELEGRAM_SIGN_IN_HINT));
});

test('kirish qoidalari ikkala holatda bir xil: hash yo‘nalish, ro‘yxatdan o‘tish, qaytish manzili o‘zgarmaydi', () => {
  for (const inTelegram of [true, false]) {
    const { props } = render(inTelegram);
    assert.equal(props.routing, 'hash'); assert.equal(props.withSignUp, true); assert.equal(props.oauthFlow, 'redirect');
    assert.equal(props.forceRedirectUrl, 'https://mini.example.org/auth/callback');
    assert.equal(props.signUpForceRedirectUrl, 'https://mini.example.org/auth/callback');
  }
});

test('ikkala kirish ekrani ham shu kartani ishlatadi va tayyor SignIn\'ni to‘g‘ridan-to‘g‘ri chaqirmaydi', () => {
  for (const file of ['../src/clerk-prebuilt-entry.tsx', '../src/telegram-atomic-entry.tsx']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /<SignInCard /); assert.doesNotMatch(source, /<SignIn[ \/]/);
  }
  assert.match(readFileSync(new URL('../src/telegram-atomic-entry.tsx', import.meta.url), 'utf8'), /<SignInCard inTelegram=\{true\}/);
  assert.match(readFileSync(new URL('../src/clerk-prebuilt-entry.tsx', import.meta.url), 'utf8'), /<SignInCard inTelegram=\{webview\}/);
});
