import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  root: '.',
  build: { outDir: 'dist', emptyOutDir: true, target: 'chrome130', chunkSizeWarningLimit: 2000 },
  server: { port: 5173, strictPort: true },
});
