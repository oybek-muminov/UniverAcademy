// Explicit test entry only. The trusted browser harness injects synthetic JWTs
// through a document-memory provider; no HTTP proof endpoint or token URL/store.
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { createClerkReviewEntry } from '../src/clerk-review-entry.ts';
import { CommonEntryPreview } from '../src/common-entry-prototype.tsx';
import { EntryDemoFailure } from '../src/common-entry-prototype.ts';
import { STUDENT_CONTRACT_SHA256 } from '../src/owner-client/student-client.ts';
import '../src/style.css';
const proof = method => {
  const bridge = window.__UA_SYNTHETIC_CLERK_PROVIDER__;
  if (typeof bridge !== 'function') throw new Error('SYNTHETIC_PROVIDER_REQUIRED');
  return bridge(method);
};
const runtime = createClerkReviewEntry({ mode: 'local_fixture', baseUrl: location.origin + '/api/v1',
  contractSha256: STUDENT_CONTRACT_SHA256,
  fetcher: request => fetch(request),
  view: (_id, meta) => ({ title: meta?.title ?? '', groupLabel: '', startAllowed: meta?.admission_status === 'open' }),
  assetUrl: value => { const url = new URL(value); if (url.origin !== location.origin) throw new Error('MEDIA_SCOPE'); return url.href; },
  provider: {
    google: () => proof('google'),
    sendCode: async () => ({ challenge: 'synthetic-challenge-review' }),
    verifyCode: async (challenge, code) => {
      if (challenge !== 'synthetic-challenge-review' || code !== '246810') throw new EntryDemoFailure('INVALID_CODE');
      return proof('email');
    },
  },
});
createRoot(document.getElementById('root')).render(createElement(CommonEntryPreview, { runtime, httpReview: true }));
