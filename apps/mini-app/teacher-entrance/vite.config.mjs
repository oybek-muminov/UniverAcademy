// Separate build only. Uses existing apps/mini-app lockfile and never writes its dist.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({ root, envDir: root, base: '/', build: {
  outDir: fileURLToPath(new URL('../dist-teacher-entrance/', import.meta.url)), emptyOutDir: true,
} });
