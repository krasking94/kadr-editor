// Режим разработки: интерфейс обновляется сразу при изменении кода (Vite), главный процесс собирается заново
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import electron from 'electron';

const server = await createServer();
await server.listen();
const url = server.resolvedUrls.local[0];
await import('./build-main.mjs');
const app = spawn(electron, ['.'], { stdio: 'inherit', env: { ...process.env, KADR_DEV_URL: url } });
app.on('close', code => { server.close(); process.exit(code ?? 0); });
