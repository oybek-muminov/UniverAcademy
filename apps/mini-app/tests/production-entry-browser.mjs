import { build, preview } from 'vite';
import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { STUDENT_CONTRACT_SHA256 } from '../src/owner-client/student-client.ts';
const servers = [];
async function serve(outDir) {
  const server = await preview({ configFile: false, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
  servers.push(server);
  return `http://127.0.0.1:${server.httpServer.address().port}`;
}
try {
  let args;
  if (process.argv.includes('--production-gates') || process.argv.includes('--common-gates')) {
    const common = process.argv.includes('--common-gates');
    const values = { VITE_MINI_APP_ORIGIN: 'https://app.invalid', VITE_API_ORIGIN: 'https://api.example.test',
      VITE_STUDENT_CONTRACT_SHA256: STUDENT_CONTRACT_SHA256,
      VITE_TELEGRAM_SDK_ENABLED: 'true', VITE_AUTH_ENTRY: common ? 'common' : '',
      VITE_CLERK_PUBLISHABLE_KEY: '', VITE_CLERK_FRONTEND_ORIGIN: '' };
    const saved = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
    const builds = [];
    try {
      for (const configured of [false, true]) {
        for (const key of Object.keys(values)) {
          if (configured || key === 'VITE_AUTH_ENTRY') process.env[key] = values[key]; else delete process.env[key];
        }
        const outDir = `test-results/${common ? 'common' : 'production'}-entry-${configured ? 'configured' : 'empty'}-build`;
        await build({ mode: 'production', build: { outDir, emptyOutDir: true } });
        const html = await readFile(outDir + '/index.html', 'utf8');
        const sdk = html.indexOf('https://telegram.org/js/telegram-web-app.js?64');
        if (configured ? sdk < 0 || sdk > html.indexOf('type="module"') : sdk !== -1) throw new Error('SDK_HEAD_GATE_FAILED');
        for (const name of await readdir(outDir + '/assets')) {
          if (!/\.(?:js|css)$/.test(name)) continue;
          const js = await readFile(outDir + '/assets/' + name, 'utf8');
          if (['synthetic-entry-access', 'synthetic-entry-refresh', '__UA_SYNTHETIC_INIT_DATA__',
            'Namuna holatlarini sinash', 'query_id=synthetic', '__UA_SYNTHETIC_CLERK_SDK_TOKEN__',
            '__UA_SDK_TEST_AUDIT__', '__UA_REACT_TEST_', 'SYNTHETIC_REACT_PROOF_REQUIRED',
            '__UA_PREBUILT_TEST_', '__SDK_TEST_COMPLETE_FORM__', 'SYNTHETIC_PREBUILT_PROOF_REQUIRED',
            'synthetic-sdk-proof-', 'Lokal prototip', '246810'].some(value => js.includes(value)))
            throw new Error('SYNTHETIC_TEST_CODE_IN_PRODUCTION');
        }
        if (common) {
          for (const name of await readdir(outDir + '/assets')) {
            if (!name.endsWith('.js')) continue;
            const js = await readFile(outDir + '/assets/' + name, 'utf8');
            if (['sign-in-email', 'Hisoblarni bog‘lash hozircha mavjud emas.', 'Tekshirish va kirish'].some(value => js.includes(value)))
              throw new Error('CUSTOM_BACKUP_FORM_IN_MAIN_PRODUCTION');
          }
        }
        builds.push({ configured, common, path: common && configured ? '/telegram' : '/', baseUrl: await serve(outDir) });
      }
    } finally {
      for (const key of Object.keys(saved)) {
        if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
      }
    }
    args = { builds };
  } else {
    const outDir = 'test-results/production-entry-synthetic-build';
    // Compile only the explicit test entry. No HMR, real SDK or public listener.
    await build({ configFile: false, build: { outDir, emptyOutDir: true,
      rollupOptions: { input: 'tests/production-entry.fixture.html' } } });
    args = { baseUrl: await serve(outDir) };
  }
  await new Promise((resolve, reject) => {
    const child = spawn('python3', ['tests/production-entry-browser.py'], { stdio: ['pipe', 'inherit', 'inherit'] });
    child.stdin.end(JSON.stringify(args) + '\n');
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('Synthetic browser test failed: ' + code)));
  });
} finally { await Promise.all(servers.map(server => new Promise(resolve => server.httpServer.close(resolve)))); }
