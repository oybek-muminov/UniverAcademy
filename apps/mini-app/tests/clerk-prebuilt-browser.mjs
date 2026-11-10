import './verify-backend-targets.mjs';
import { build, preview } from 'vite';
import { spawn } from 'node:child_process';
import { startClerkReviewServer } from '../../../runtime/clerk-review-server.mjs';

const outDir = 'test-results/clerk-prebuilt-package-build';
await build({ configFile: false, build: { outDir, emptyOutDir: true,
  rollupOptions: { input: 'tests/clerk-prebuilt.fixture.html' } } });
const assets = await preview({ configFile: false, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
try {
  for (const scenario of ['widget-explicit', 'cached-session', 'cancel-body', 'user-cancel', 'logout-new-session', 'revoked', 'webview']) {
    const backend = await startClerkReviewServer();
    try {
      const proofs = [await backend.lab.sign(), await backend.lab.sign()];
      await new Promise((resolve, reject) => {
        const child = spawn('python3', ['-B', 'tests/clerk-prebuilt-browser.py'], { stdio: ['pipe', 'inherit', 'inherit'] });
        child.stdin.end(JSON.stringify({ assets: `http://127.0.0.1:${assets.httpServer.address().port}`, api: backend.baseUrl,
          scenario, proofs }) + '\n');
        child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('CLERK_PREBUILT_MOUNT_TEST_FAILED:' + code)));
      });
    } finally { await backend.close(); }
  }
} finally { await new Promise(resolve => assets.httpServer.close(resolve)); }
