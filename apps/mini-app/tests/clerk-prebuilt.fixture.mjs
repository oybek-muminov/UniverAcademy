// Real pinned React SDK wrapper/hooks. The vendor UI/client, session and proof
// remain synthetic; this verifies mount/lifecycle contracts, not Clerk's design.
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ClerkProvider, ClerkLoaded } from '@clerk/react';
import { CommonClerkEntry } from '../src/common-production-entry.tsx';
import { readCommonEntryConfig } from '../src/common-production-runtime.ts';
import { STUDENT_CONTRACT_SHA256 } from '../src/owner-client/student-client.ts';
import { fakeClerkSdk } from './fixtures/clerk-sdk.fixture.mjs';
import '../src/style.css';

const listeners = new Set(), mounts = [], signOuts = [];
const emit = () => { client.__internal_lastEmittedResources = { session: fixture.sdk.session(), user: null, organization: null, client: client.client }; listeners.forEach(f => f()); };
const fixture = fakeClerkSdk({
  token: async () => {
    if (typeof window.__UA_PREBUILT_TEST_PROOF__ !== 'function') throw new Error('SYNTHETIC_PREBUILT_PROOF_REQUIRED');
    return window.__UA_PREBUILT_TEST_PROOF__();
  },
  signOut: async id => {
    signOuts.push(id);
    if (window.__UA_PREBUILT_TEST_DELAY_SIGNOUT__) await new Promise(resolve => { window.__UA_PREBUILT_TEST_RELEASE_SIGNOUT__ = resolve; });
  },
});
const signInSignal = { signIn: fixture.sdk.signIn, fetchStatus: 'idle', errors: null };
const signUpSignal = { signUp: fixture.sdk.signUp, fetchStatus: 'idle', errors: null };
const client = {
  loaded: true, status: 'ready', client: { sessions: [] }, user: null, organization: null,
  on(event, callback) { if (event === 'status') queueMicrotask(() => callback('ready')); return () => {}; }, off() {},
  get session() { return fixture.sdk.session(); },
  addListener(callback, options) { listeners.add(callback); if (!options?.skipInitialEmit) callback(); return () => listeners.delete(callback); },
  __internal_state: { signInSignal: () => signInSignal, signUpSignal: () => signUpSignal,
    __internal_effect(callback) { listeners.add(callback); callback(); return () => listeners.delete(callback); } },
  signOut: async ({ sessionId }) => { await fixture.sdk.signOut(sessionId); emit(); },
  mountSignIn(node, props) {
    mounts.push(props);
    // Clearly marked test driver, never a mock-up presented as the vendor form.
    const button = document.createElement('button'); button.textContent = '__SDK_TEST_COMPLETE_FORM__';
    button.onclick = () => { fixture.setSession(fixture.makeSession('sess_WidgetSynthetic')); emit(); };
    node.replaceChildren(button);
  },
  unmountSignIn(node) { node.replaceChildren(); },
};
window.__UA_PREBUILT_TEST_SESSION__ = id => { fixture.setSession(id ? fixture.makeSession(id) : null); emit(); };
window.__UA_PREBUILT_TEST_AUDIT__ = () => ({ session: client.session?.id ?? null, signOuts,
  proofReads: fixture.calls.filter(c => c[0] === 'getToken').length, mounts });
const nativeFetch = window.fetch;
window.fetch = async (...args) => {
  const response = await nativeFetch(...args);
  if (window.__UA_PREBUILT_TEST_HOLD_BODY__ && response.url.endsWith('/auth/clerk')) {
    window.__UA_PREBUILT_TEST_HOLD_BODY__ = false;
    const read = response.json.bind(response);
    response.json = async () => {
      const body = await read();
      await new Promise(resolve => { window.__UA_PREBUILT_TEST_RELEASE_BODY__ = resolve; }); return body;
    };
  }
  return response;
};
const query = new URLSearchParams(location.search);
if (query.has('cached')) fixture.setSession(fixture.makeSession('sess_CachedSynthetic'));
const scope = query.has('webview') ? { Telegram: { WebApp: { initData: 'query_id=synthetic-prebuilt-view', ready() {}, expand() {} } } } : {};
emit();
const config = readCommonEntryConfig({ VITE_MINI_APP_ORIGIN: 'https://app.example.test', VITE_API_ORIGIN: 'https://api.example.test',
  VITE_STUDENT_CONTRACT_SHA256: STUDENT_CONTRACT_SHA256, VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_' + btoa('clerk.example.test$'),
  VITE_CLERK_FRONTEND_ORIGIN: 'https://clerk.example.test' }, location.origin);
createRoot(document.getElementById('root')).render(createElement(ClerkProvider, {
  publishableKey: config.publishableKey, Clerk: client, telemetry: { disabled: true }, prefetchUI: false,
}, createElement(ClerkLoaded, null, createElement(CommonClerkEntry, { config, scope }))));
