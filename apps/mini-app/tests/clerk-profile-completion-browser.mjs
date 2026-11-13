import './verify-backend-targets.mjs';
import { build, preview } from 'vite';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createClerkReviewLab, startClerkReviewServer } from '../../../runtime/clerk-review-server.mjs';

// Existing approved UI and synthetic Clerk wrapper. Fixture names model a server
// profile response; this does not implement or validate Backend provider prefill.
const temp = await mkdtemp(join(tmpdir(), 'ua-clerk-profile-'));
const outDir = join(temp, 'assets');
let assets;
try {
  await build({ configFile: false, build: { outDir, emptyOutDir: true,
    rollupOptions: { input: 'tests/clerk-prebuilt.fixture.html' } } });
  assets = await preview({ configFile: false, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
  const cases = [
    ...[320, 390, 1280].map(width => ({ scenario: 'both', width })),
    ...[320, 390, 1280].map(width => ({ scenario: 'first-only-edit-reload', width })),
    { scenario: 'last-only', width: 390 }, { scenario: 'completed', width: 390 },
    { scenario: 'patch503', width: 390 },
  ];
  for (const { scenario, width } of cases) {
    const lab = await createClerkReviewLab();
    const person = lab.store.state.domain.student.people[lab.ids.person];
    Object.assign(person.profile, { first_name: scenario === 'last-only' ? '' : scenario === 'completed' ? 'Edited Ism' : 'Server Ism',
      last_name: scenario === 'first-only-edit-reload' ? '' : scenario === 'completed' ? 'Edited Familiya' : 'Server Familiya',
      registration_complete: scenario === 'completed' });
    lab.store.state.domain.student.assignments = {}; // Authorized empty response, no exam seed.
    if (scenario === 'patch503') {
      const handler = lab.handler;
      lab.handler = request => { if (request.method === 'PATCH' && new URL(request.url).pathname === '/api/v1/me')
        lab.store.failCommit = 'before'; return handler(request); };
    }
    const server = await startClerkReviewServer({ lab });
    try {
      const proofs = [await lab.sign(lab.actors.existing), await lab.sign(lab.actors.existing)];
      await new Promise((resolve, reject) => {
        const child = spawn('python3', ['-B', new URL('./clerk-profile-completion-browser.py', import.meta.url).pathname],
          { stdio: ['pipe', 'inherit', 'inherit'] });
        child.stdin.end(JSON.stringify({ scenario, width, proofs, sessionId: lab.actors.existing.sessionId,
          assets: `http://127.0.0.1:${assets.httpServer.address().port}`, api: server.baseUrl }) + '\n');
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(`PROFILE_COMPLETION_BROWSER_FAILED:${scenario}:${width}:${code}`)));
      });
    } finally { await server.close(); }
  }
} finally {
  if (assets) await new Promise(resolve => assets.httpServer.close(resolve));
  await rm(temp, { recursive: true, force: true }); // Only this new generated build directory.
}
