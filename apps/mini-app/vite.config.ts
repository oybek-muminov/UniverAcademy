import { defineConfig, loadEnv } from 'vite';
import { clerkLoadPromiseFix } from './tools/clerk-load-promise-fix.mjs';

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    define: { __AUTH_PROTOTYPE_PREVIEW__: JSON.stringify(command === 'serve' && mode === 'auth_prototype') },
    // Prepared host integration only; no SDK network request occurs during build.
    // Default builds do not inject a remote SDK. Browser tests intercept this URL.
    optimizeDeps: { rolldownOptions: { plugins: [clerkLoadPromiseFix()] } },
    plugins: [clerkLoadPromiseFix(), { name: 'telegram-sdk-entry', transformIndexHtml() {
      if (command === 'build' && mode === 'production' && env.VITE_TELEGRAM_SDK_ENABLED === 'true')
        return [{ tag: 'script', attrs: { src: 'https://telegram.org/js/telegram-web-app.js?64', referrerpolicy: 'no-referrer' }, injectTo: 'head-prepend' as const }];
      return [];
    } }],
    // Loopback fixture proxy only. Production cross-origin CORS belongs to Backend.
    ...(mode === 'local_fixture' ? {
      server: { host: '127.0.0.1', proxy: { '/api/v1': { target: 'http://127.0.0.1:8789' } } },
    } : {}),
  };
});
