// Сборка главного процесса и preload в один файл каждый
import { build } from 'esbuild';
const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], sourcemap: false, minify: false, logLevel: 'warning' };
await build({ ...common, entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.js' });
await build({ ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.js' });
await build({ ...common, entryPoints: ['electron/mcp-bridge.ts'], outfile: 'dist-electron/mcp-bridge.js' });
console.log('main + preload + mcp-bridge собраны');
