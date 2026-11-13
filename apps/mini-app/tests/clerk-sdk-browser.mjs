import './verify-backend-targets.mjs';
import { build, preview } from 'vite';
import { spawn } from 'node:child_process';
import { startClerkReviewServer } from '../../../runtime/clerk-review-server.mjs';

const outDir = 'test-results/clerk-sdk-facade-build';
await build({ configFile: false, build: { outDir, emptyOutDir: true,
  rollupOptions: { input: 'tests/clerk-sdk.fixture.html' } } });
const assets = await preview({ configFile: false, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
try { for (const width of [320, 390, 1280]) {
  const backend = await startClerkReviewServer();
  try {
    const proofs = [await backend.lab.sign(), await backend.lab.sign(), await backend.lab.sign(backend.lab.actors.fresh)];
    await new Promise((resolve, reject) => {
      const child = spawn('python3', ['-B', 'tests/clerk-sdk-browser.py'], { stdio: ['pipe', 'inherit', 'inherit'] });
      child.stdin.end(JSON.stringify({ assets: `http://127.0.0.1:${assets.httpServer.address().port}`, api: backend.baseUrl,
        width, proofs, screens: process.argv[2] ?? 'test-results/clerk-sdk/screenshots' }) + '\n');
      child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('SDK_FACADE_BROWSER_FAILED:' + code)));
    });
  } finally { await backend.close(); }
} } finally { await new Promise(resolve => assets.httpServer.close(resolve)); }
