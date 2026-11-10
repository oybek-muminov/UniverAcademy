import './verify-backend-targets.mjs';
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { startLocalServer } from '../../../runtime/local-server.mjs';
import { syntheticLoginInput } from '../../../runtime/local-lab.mjs';
import { numericLab } from './numeric-lab.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const evidence = new URL('../test-results/', import.meta.url);
await mkdir(evidence, { recursive: true });
const vite = await createServer({ root, mode: 'local_fixture', server: { host: '127.0.0.1', port: 5198, strictPort: true } });
await vite.listen();
try {
  for (const width of [320, 390, 1280]) {
    const backend = await startLocalServer({ port: 8789 });
    try {
      const args = { url: 'http://127.0.0.1:5198/', width,
        initData: [syntheticLoginInput().init_data, syntheticLoginInput().init_data],
        screenshot: fileURLToPath(new URL(`browser-http-${width}.png`, evidence)) };
      const child = spawn('python3', ['-B', fileURLToPath(new URL('browser-http.py', import.meta.url))],
        { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      child.stdin.end(JSON.stringify(args)); // Synthetic proofs never logged or persisted.
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
      if (code !== 0) throw new Error(`Browser fixture${width} failed: ${stderr}`);
      process.stdout.write(stdout);
    } finally { await backend.close(); }
  }
  for (const [input, expected] of [['2.34', '2.3'], ['2.35', '2.4'], ['2.355', '2.4'], ['2.349', '2.3']]) {
    const backend = await startLocalServer({ port: 8789, lab: numericLab(input) });
    try {
      const args = { url: 'http://127.0.0.1:5198/', input, expected, initData: syntheticLoginInput().init_data,
        screenshot: fileURLToPath(new URL(`browser-numeric-${input.replace('.', '_')}.png`, evidence)) };
      const child = spawn('python3', ['-B', fileURLToPath(new URL('browser-numeric.py', import.meta.url))],
        { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      child.stdin.end(JSON.stringify(args));
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
      if (code !== 0) throw new Error(`Browser numeric fixture failed: ${stderr}`);
      process.stdout.write(stdout);
    } finally { await backend.close(); }
  }
} finally { await vite.close(); }
