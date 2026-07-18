import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

let sha = 'dev';
try { sha = execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim(); } catch { /* not a repo */ }

export default defineConfig({
  plugins: [react()],
  base: '/',
  build: { outDir: 'dist', sourcemap: false },
  define: { __UI_BUILD_SHA__: JSON.stringify(sha) },
});
