import './verify-backend-targets.mjs';
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { startClerkReviewServer } from '../../../runtime/clerk-review-server.mjs';

const screens = resolve(process.argv[2] ?? 'test-results/clerk-review/screenshots');
for (const width of [320, 390, 1280]) {
  const backend = await startClerkReviewServer({ allowedOrigins: ['http://127.0.0.1:5218'] });
  let vite;
  try {
    vite = await createServer({ mode: 'auth_prototype', server: { host: '127.0.0.1', port: 5218, strictPort: true,
      proxy: { '/api/v1': { target: new URL(backend.baseUrl).origin } } } });
    await vite.listen();
    const url = `http://127.0.0.1:${vite.httpServer.address().port}/tests/clerk-review.fixture.html`;
    const proofs = [await backend.lab.sign(), await backend.lab.sign(),
      await backend.lab.sign(backend.lab.actors.fresh), await backend.lab.sign(), await backend.lab.sign()];
    await new Promise((resolve, reject) => {
      const child = spawn('python3', ['-B', 'tests/clerk-review-browser.py'], { stdio: ['pipe', 'inherit', 'inherit'] });
      // Ephemeral synthetic proofs travel in process memory, never a file/log/URL.
      child.stdin.end(JSON.stringify({ url, width, screens, proofs }) + '\n');
      child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('CLERK_REVIEW_BROWSER_FAILED:' + code)));
    });
  } finally { if (vite) await vite.close(); await backend.close(); }
}
