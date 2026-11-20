// Separate build only. Uses existing apps/mini-app lockfile and never writes its dist.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { clerkLoadPromiseFix } from '../tools/clerk-load-promise-fix.mjs';
const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({ root, envDir: root, base: '/',
  plugins: [clerkLoadPromiseFix()],
  optimizeDeps: { rolldownOptions: { plugins: [clerkLoadPromiseFix()] } },
  build: {
  outDir: fileURLToPath(new URL('../dist-teacher-entrance/', import.meta.url)), emptyOutDir: true,
} });
