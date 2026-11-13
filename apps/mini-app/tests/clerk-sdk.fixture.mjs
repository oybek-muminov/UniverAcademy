// Test entry only. Public SDK shape is simulated; Backend HTTP is loopback RAM.
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { fakeClerkSdk } from './fixtures/clerk-sdk.fixture.mjs';
import { CommonSignInView } from '../src/common-sign-in-view.tsx';
import { createCommonProductionRuntime, readCommonEntryConfig } from '../src/common-production-runtime.ts';
import { STUDENT_CONTRACT_SHA256 } from '../src/owner-client/student-client.ts';
import '../src/style.css';
const fixture = fakeClerkSdk({
  token: async () => {
    const read = window.__UA_SYNTHETIC_CLERK_SDK_TOKEN__;
    if (typeof read !== 'function') throw new Error('TEST_PROOF_REQUIRED');
    return read();
  },
  verify: async ({ code }) => {
    if (code !== '123456') return { error: { errors: [{ code: 'form_code_incorrect' }] } };
    fixture.sdk.signIn.status = 'complete'; fixture.sdk.signIn.createdSessionId = 'sess_EmailFixture'; return { error: null };
  },
  finalize: async (kind, input, activate) => {
    if (window.__UA_DELAY_SYNTHETIC_SDK__) {
      delete window.__UA_DELAY_SYNTHETIC_SDK__;
      await new Promise(resolve => { window.__UA_RELEASE_SYNTHETIC_SDK__ = () => { delete window.__UA_RELEASE_SYNTHETIC_SDK__; resolve(); }; });
    }
    activate(fixture.sdk[kind].createdSessionId); return { error: null };
  },
});
const config = readCommonEntryConfig({ VITE_MINI_APP_ORIGIN: 'https://app.example.test', VITE_API_ORIGIN: 'https://api.example.test',
  VITE_STUDENT_CONTRACT_SHA256: STUDENT_CONTRACT_SHA256, VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_' + btoa('clerk.example.test$'),
  VITE_CLERK_FRONTEND_ORIGIN: 'https://clerk.example.test' }, location.origin);
const runtime = createCommonProductionRuntime(config, fixture.sdk, 'browser');
window.__UA_SDK_TEST_AUDIT__ = () => ({ sdkSession: fixture.sdk.session()?.id ?? null,
  signOut: fixture.calls.filter(c => c[0] === 'signOut').map(c => c[1]), step: runtime.snapshot().step });
createRoot(document.getElementById('root')).render(createElement(CommonSignInView,
  { runtime, canContinue: false, telegramUrl: 'https://t.me/univeracademybot' }));
