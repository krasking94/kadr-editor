// Скачивает FFmpeg для Windows в resources/ffmpeg/win32 (его кладёт в установщик electron-builder).
// FFmpeg — отдельная программа со своей лицензией (GPL), «Кадр» вызывает её как внешний процесс.
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';

const SOURCES = [
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl-shared.zip',
  'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
];
const target = join('resources', 'ffmpeg', 'win32');
if (existsSync(join(target, 'ffmpeg.exe')) && !process.argv.includes('--force')) {
  console.log('FFmpeg уже скачан:', target);
  process.exit(0);
}
mkdirSync(target, { recursive: true });
const tmp = join('resources', 'ffmpeg', '_download');
rmSync(tmp, { recursive: true, force: true });
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
mkdirSync(tmp, { recursive: true });

function findFile(dir, name) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { const r = findFile(p, name); if (r) return r; }
    else if (f.toLowerCase() === name) return p;
  }
  return null;
}

let ok = false;
for (const url of SOURCES) {
  try {
    console.log('Скачиваю', url);
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const zip = join(tmp, 'ffmpeg.zip');
    await pipeline(Readable.fromWeb(res.body), createWriteStream(zip));
    // tar из Windows 10+ и bsdtar умеют распаковывать zip
    try { execFileSync('tar', ['-xf', zip, '-C', tmp], { stdio: 'ignore' }); } catch { execFileSync('unzip', ['-q', zip, '-d', tmp]); }
    // берём папку bin целиком: в «shared»-сборке ffmpeg и ffprobe используют общие библиотеки .dll
    const main = findFile(tmp, 'ffmpeg.exe');
    if (!main || !findFile(tmp, 'ffprobe.exe')) throw new Error('В архиве нет ffmpeg.exe или ffprobe.exe');
    const bin = dirname(main);
    for (const f of readdirSync(bin)) if (/\.(exe|dll)$/i.test(f) && f.toLowerCase() !== 'ffplay.exe') copyFileSync(join(bin, f), join(target, f));
    const lic = findFile(tmp, 'license.txt');
    if (lic) copyFileSync(lic, join(target, 'LICENSE-ffmpeg.txt'));
    ok = true;
    break;
  } catch (e) {
    console.warn('Не получилось:', e.message);
  }
}
rmSync(tmp, { recursive: true, force: true });
if (!ok) { console.error('FFmpeg не скачан'); process.exit(1); }
console.log('FFmpeg готов:', target);
