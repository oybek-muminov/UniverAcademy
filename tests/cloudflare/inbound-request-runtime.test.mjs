import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVercelNodeFunction } from '../../runtime/vercel-node.mjs';

// Model only the documented Workers Request constructor restriction. No identity,
// proof, provider, database, deployed environment or authenticated flow is created.
test('bounded inbound POST supports Workers no-error redirect mode and stays fail-closed', async () => {
  const NativeRequest = globalThis.Request;
  const modes = [];
  globalThis.Request = class extends NativeRequest {
    constructor(input, init) {
      if (init?.redirect === 'error') throw new TypeError('Unsupported redirect mode');
      super(input, init); modes.push(this.redirect);
    }
  };
  try {
    const apiOrigin = 'https://api.example.com', origin = 'https://mini.example.com';
    const app = createVercelNodeFunction({ apiOrigin, allowedOrigins: [origin] });
    for (const path of ['/api/v1/auth/clerk', '/api/v1/auth/telegram/resume']) {
      const response = await app.fetch(new Request(apiOrigin + path, {
        method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}', redirect: 'manual',
      }));
      assert.equal(response.status, 503); // no configured auth/storage; never admits a session
      assert.equal((await response.json()).error.code, 'SERVICE_UNAVAILABLE');
      assert.equal(response.headers.get('access-control-allow-origin'), origin);
    }
    assert.deepEqual(modes, ['manual', 'manual', 'manual', 'manual']);
  } finally { globalThis.Request = NativeRequest; }
});
