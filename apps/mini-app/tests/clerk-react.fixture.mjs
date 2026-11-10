// Actual pinned @clerk/react components/hooks, synthetic client/session only.
// The test-only client models the versioned SDK's private signal storage solely
// to drive its public hooks. Production does not import this file or these seams.
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ClerkProvider, ClerkLoaded } from '@clerk/react';
import { BackupCommonClerkEntry } from '../src/common-backup-entry.tsx';
import { readCommonEntryConfig } from '../src/common-production-runtime.ts';
import { STUDENT_CONTRACT_SHA256 } from '../src/owner-client/student-client.ts';
import { fakeClerkSdk } from './fixtures/clerk-sdk.fixture.mjs';
import '../src/style.css';

const listeners = new Set();
const emit = () => { client.__internal_lastEmittedResources = { session: fixture.sdk.session(), user: null, organization: null, client: client.client }; listeners.forEach(f => f()); };
const fixture = fakeClerkSdk({
  token: async () => {
    if (typeof window.__UA_REACT_TEST_PROOF__ !== 'function') throw new Error('SYNTHETIC_REACT_PROOF_REQUIRED');
    return window.__UA_REACT_TEST_PROOF__();
  },
  finalize: async (kind, input, activate) => {
    const id = fixture.sdk[kind].createdSessionId, session = fixture.makeSession(id);
    if (window.__UA_DELAY_REACT_FINALIZE__) await new Promise(resolve => { window.__UA_RELEASE_REACT_FINALIZE__ = resolve; });
    await input.navigate?.({ session, decorateUrl: url => url }); activate(id); emit(); return { error: null };
  },
});
const signInSignal = { signIn: fixture.sdk.signIn, fetchStatus: 'idle', errors: null };
const signUpSignal = { signUp: fixture.sdk.signUp, fetchStatus: 'idle', errors: null };
const client = {
  loaded: true, status: 'ready', client: { sessions: [] }, user: null, organization: null,
  on(event, callback) { if (event === 'status') queueMicrotask(() => callback('ready')); return () => {}; },
  off() {},
  get session() { return fixture.sdk.session(); },
  addListener(callback, options) { listeners.add(callback); if (!options?.skipInitialEmit) callback(); return () => listeners.delete(callback); },
  __internal_state: { signInSignal: () => signInSignal, signUpSignal: () => signUpSignal,
    __internal_effect(callback) { listeners.add(callback); callback(); return () => listeners.delete(callback); } },
  signOut: async ({ sessionId }) => { await fixture.sdk.signOut(sessionId); emit(); },
};
emit();
window.__UA_REACT_TEST_AUDIT__ = () => ({ session: client.session?.id ?? null, signOut: fixture.calls.filter(c => c[0] === 'signOut').length,
  proofReads: fixture.calls.filter(c => c[0] === 'getToken').length });
window.__UA_REACT_TEST_EXTERNAL_SESSION__ = () => { fixture.setSession(fixture.makeSession('sess_ExplicitExternal')); emit(); };
if (location.pathname === '/auth/callback') {
  fixture.sdk.signIn.status = 'complete'; fixture.sdk.signIn.createdSessionId = 'sess_CallbackFixture';
  if (new URLSearchParams(location.search).has('delay')) window.__UA_DELAY_REACT_FINALIZE__ = true;
}
const config = readCommonEntryConfig({ VITE_MINI_APP_ORIGIN: 'https://app.example.test', VITE_API_ORIGIN: 'https://api.example.test',
  VITE_STUDENT_CONTRACT_SHA256: STUDENT_CONTRACT_SHA256, VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_' + btoa('clerk.example.test$'),
  VITE_CLERK_FRONTEND_ORIGIN: 'https://clerk.example.test' }, location.origin);
const root = createRoot(document.getElementById('root'));
root.render(createElement(ClerkProvider, { publishableKey: config.publishableKey, Clerk: client, telemetry: { disabled: true }, prefetchUI: false },
  createElement(ClerkLoaded, null, createElement(BackupCommonClerkEntry, { config, scope: window }))));
