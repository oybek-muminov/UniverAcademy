// Production entry and real pinned SDK loader; reserved hosts intercepted only.
import { build, preview, createServer } from 'vite';
import { spawn } from 'node:child_process';
import { STUDENT_CONTRACT_SHA256 } from '../src/owner-client/student-client.ts';
const baseline = process.argv.includes('--baseline-control'), dev = process.argv.includes('--dev');
const values = { VITE_AUTH_ENTRY: 'common', VITE_CLERK_SDK_ENABLED: process.argv.includes('--empty-socket') ? '' : 'true', VITE_MINI_APP_ORIGIN: 'https://app.example.test',
  VITE_API_ORIGIN: 'https://api.example.test', VITE_STUDENT_CONTRACT_SHA256: STUDENT_CONTRACT_SHA256,
  VITE_TELEGRAM_SDK_ENABLED: '', VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_' + btoa('clerk.example.test$'),
  VITE_CLERK_FRONTEND_ORIGIN: 'https://clerk.example.test' };
const saved = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
const outDir = `test-results/clerk-load-${baseline ? 'baseline' : process.argv.includes('--empty-socket') ? 'empty-socket' : 'fixed'}-build`;
let server;
try {
  Object.assign(process.env, values);
  if (dev) { server = await createServer({ mode: 'production', cacheDir: 'test-results/clerk-load-dev-cache',
    server: { host: '127.0.0.1', port: 0, hmr: false } }); await server.listen(); }
  else {
    await build({ mode: 'production', build: { outDir, emptyOutDir: true } });
    server = await preview({ configFile: false, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
  }
  const address = server.httpServer.address();
  await new Promise((resolve, reject) => {
    const child = spawn('python3', ['-B', 'tests/clerk-load-browser.py'], { stdio: ['pipe', 'inherit', 'inherit'] });
    child.stdin.end(JSON.stringify({ assets: `http://127.0.0.1:${address.port}`, baseline, dev, emptySocket: process.argv.includes('--empty-socket') }) + '\n');
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('CLERK_LOAD_BROWSER_FAILED:' + code)));
  });
} finally {
  if (server) { if (dev) await server.close(); else await new Promise(resolve => server.httpServer.close(resolve)); }
  for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
