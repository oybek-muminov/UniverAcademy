import { createServer, build } from 'vite';
import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const screens = resolve(process.argv[2] ?? 'test-results/common-entry-preview/screenshots');
const server = await createServer({ mode: 'auth_prototype', server: { host: '127.0.0.1', port: 0 } });
await server.listen();
try {
  const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
  await new Promise((resolve, reject) => {
    const child = spawn('python3', ['tests/common-entry-browser.py'], { stdio: ['pipe', 'inherit', 'inherit'] });
    child.stdin.end(JSON.stringify({ url, screens }) + '\n');
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('COMMON_ENTRY_BROWSER_FAILED:' + code)));
  });
} finally { await server.close(); }
// Isolate the build from createServer's NODE_ENV; command-based gate is independent.
const savedNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';
try {
// Even a production build accidentally named auth_prototype must exclude fixtures.
for (const mode of ['production', 'auth_prototype']) {
  const outDir = `test-results/common-entry-${mode}-production-gate`;
  await build({ mode, build: { outDir, emptyOutDir: true } });
  for (const name of await readdir(outDir + '/assets')) {
    if (!name.endsWith('.js') && !name.endsWith('.css')) continue;
    const code = await readFile(outDir + '/assets/' + name, 'utf8');
    if (['synthetic-google-evidence', 'synthetic-email-evidence', 'synthetic-challenge-', '246810',
      'entry-google-mark', 'Lokal prototip', 'Namuna uchun faqat example.test',
      '__UA_SYNTHETIC_CLERK_PROVIDER__', 'synthetic-challenge-review'].some(marker => code.includes(marker)))
      throw new Error('AUTH_PROTOTYPE_IN_PRODUCTION:' + name);
  }
}
process.stdout.write('PRODUCTION_PROTOTYPE_EXCLUSION_2_OF_2_PASS\n');
} finally {
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNodeEnv;
}
