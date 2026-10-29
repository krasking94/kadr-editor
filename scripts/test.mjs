// Собирает тесты из TypeScript и запускает встроенный в Node тестировщик
import { build } from 'esbuild';
import { readdirSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const files = readdirSync('tests').filter(f => f.endsWith('.test.ts')).map(f => 'tests/' + f);
mkdirSync('.test-build', { recursive: true });
await build({ entryPoints: files, outdir: '.test-build', bundle: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'warning' });
const r = spawnSync(process.execPath, ['--test', ...files.map(f => '.test-build/' + f.split('/').pop().replace('.ts', '.js'))], { stdio: 'inherit' });
process.exit(r.status ?? 1);
