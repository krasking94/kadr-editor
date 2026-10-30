import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';

// Движок MediaPipe (поиск лица для вертикали) работает без интернета: кладём его файлы рядом с программой
const mediapipe = () => ({
  name: 'kadr-mediapipe',
  buildStart() {
    const from = 'node_modules/@mediapipe/tasks-vision/wasm';
    mkdirSync('public/mediapipe', { recursive: true });
    for (const f of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm']) {
      if (existsSync(`${from}/${f}`)) copyFileSync(`${from}/${f}`, `public/mediapipe/${f}`);
    }
  },
});

export default defineConfig({
  plugins: [react(), mediapipe()],
  base: './',
  root: '.',
  build: { outDir: 'dist', emptyOutDir: true, target: 'chrome130', chunkSizeWarningLimit: 2000 },
  server: { port: 5173, strictPort: true },
});
