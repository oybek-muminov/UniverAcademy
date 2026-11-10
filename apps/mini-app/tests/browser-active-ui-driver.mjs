import './verify-backend-targets.mjs';
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { startLocalServer } from '../../../runtime/local-server.mjs';
import { syntheticLoginInput } from '../../../runtime/local-lab.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const evidence = fileURLToPath(new URL('../test-results/', import.meta.url));
await mkdir(evidence, { recursive: true });
const vite = await createServer({ root, mode: 'local_fixture',
  server: { host: '127.0.0.1', port: 5201, strictPort: true } });
await vite.listen();
try {
  for (const width of [320, 390, 1280]) {
    const backend = await startLocalServer({ port: 8789 });
    try {
      const child = spawn('python3', ['-B', fileURLToPath(new URL('browser-active-ui.py', import.meta.url))],
        { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
      const completed = new Promise(resolve => {
        child.once('error', () => resolve(null));
        child.once('close', resolve);
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      child.stdin.end(JSON.stringify({ url: 'http://127.0.0.1:5201/', width, evidence,
        initData: [syntheticLoginInput().init_data, syntheticLoginInput().init_data] }));
      if (await completed !== 0) throw new Error(`Active UI browser ${width} failed: ${stderr}`);
      process.stdout.write(stdout);
    } finally { await backend.close(); }
  }
} finally { await vite.close(); }
