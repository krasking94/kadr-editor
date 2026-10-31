// Главный процесс «Хлопушки»: окно, доступ к файлам, FFmpeg, ИИ и MCP.
import { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, Menu, nativeTheme, protocol, session, shell, screen } from 'electron';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { ExportOptions, Project } from '../shared/types';
import { buildExportArgs } from '../shared/export-graph';
import { projectDuration } from '../shared/timeline';
import { FFMPEG, ffmpegAvailable, probe, thumbnails, waveform, detectSilence, detectScenes, hardwareEncoders, pcm, run } from './ffmpeg';
import { getSettings, setSettings, setSecret, secretStatus } from './settings';
import { attachWindow, notify } from './bridge';
import { chat, complete, listModels, resetSession, stopAi, transcribeFile } from './ai';
import { audioSnippet, bgCleanup, bgFinish, bgFrames, bgPrepare, bgWrite, cancelProcess, makeProxy, measureLoudness, processClip, type ProcessKind } from './process';
import { detectBeats } from '../shared/beats';
import { estimateWords } from '../shared/speech';
import { checkForUpdates, downloadUpdate, installUpdate, updateState } from './updater';
import { clientStatus, mcpServerState, startMcpServer, stopMcpServer, syncClients } from './mcp';
import { cancelVideo, generateImage, generateMusic, generateSoundEffect, generateSpeech, generateVideo, listVoices } from './generate';
import { bridgeSelfTest, connectClaudeDesktop, desktopEntry, desktopStatus } from './desktop-link';

// До версии 0.3 программа называлась «Кадр» (Kadr). Настройки, ключи нейросетей, список проектов
// и автосохранения остаются в прежней папке, чтобы после обновления ничего не пропало.
app.setPath('userData', join(app.getPath('appData'), 'Kadr'));

const isDev = !!process.env.KADR_DEV_URL;
let win: BrowserWindow | null = null;
let allowClose = false;
let pendingOpen: string | null = process.argv.find(a => a.toLowerCase().endsWith('.kadr') && existsSync(a)) || null;

protocol.registerSchemesAsPrivileged([
  { scheme: 'kadr-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, bypassCSP: true, corsEnabled: true } },
]);

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', (_e, argv) => {
  const file = argv.find(a => a.toLowerCase().endsWith('.kadr'));
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
    if (file) win.webContents.send('project:open-path', file);
  }
});

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.opus': 'audio/ogg',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff2': 'font/woff2',
  '.wasm': 'application/wasm', '.js': 'text/javascript', '.tflite': 'application/octet-stream',
};

// Отдаёт локальные файлы окну с поддержкой перемотки (Range-запросы)
function registerMediaProtocol() {
  protocol.handle('kadr-media', async req => {
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname.slice(1));
    if (!existsSync(path)) return new Response('Not found', { status: 404 });
    const size = statSync(path).size;
    const type = MIME[extname(path).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.get('range');
    if (range) {
      const m = range.match(/bytes=(\d*)-(\d*)/);
      const start = m && m[1] ? Number(m[1]) : 0;
      const end = m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      const stream = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream;
      return new Response(stream, {
        status: 206,
        headers: { 'content-type': type, 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'access-control-allow-origin': '*' },
      });
    }
    const stream = Readable.toWeb(createReadStream(path)) as ReadableStream;
    return new Response(stream, { headers: { 'content-type': type, 'content-length': String(size), 'accept-ranges': 'bytes', 'access-control-allow-origin': '*' } });
  });
}

function createWindow() {
  const s = getSettings();
  nativeTheme.themeSource = s.theme;
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.min(1600, width), height: Math.min(1000, height), minWidth: 1024, minHeight: 640,
    backgroundColor: '#0d0e12', show: false, title: 'Хлопушка',
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? undefined : { color: '#00000000', symbolColor: '#c9cad6', height: 44 },
    icon: join(app.getAppPath(), 'dist', 'icon.png'),
    webPreferences: {
      preload: join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false,
      backgroundThrottling: false,
    },
  });
  attachWindow(win);
  win.once('ready-to-show', () => win?.show());
  win.on('close', e => {
    if (allowClose) return;
    e.preventDefault();
    win?.webContents.send('app:close-request');
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  if (isDev) win.loadURL(process.env.KADR_DEV_URL!);
  else win.loadFile(join(app.getAppPath(), 'dist', 'index.html'));
  if (process.argv.includes('--smoke-test')) smokeTest(win);
}

// Проверка собранной программы (запускается на сервере сборки): окно открылось, интерфейс нарисован, FFmpeg найден
function smokeTest(w: BrowserWindow) {
  const fail = setTimeout(() => { console.log('SMOKE FAIL: timeout'); app.exit(1); }, 60000);
  w.webContents.once('did-finish-load', async () => {
    await new Promise(r => setTimeout(r, 4000));
    const ui = await w.webContents.executeJavaScript(`!!document.querySelector('.welcome h1')`).catch(() => false);
    const ff = ffmpegAvailable();
    const mcp = mcpServerState();
    const bridge = await bridgeSelfTest(mcp.port).catch(e => ({ ok: false, error: String(e) }));
    console.log('SMOKE', JSON.stringify({ ui, ffmpeg: ff, mcp, bridge }));
    clearTimeout(fail);
    allowClose = true;
    app.exit(ui && ff.ok && bridge.ok ? 0 : 1);
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  registerMediaProtocol();
  createWindow();
  const s = getSettings();
  if (s.mcp.serverEnabled) await startMcpServer(s.mcp.port);
  syncClients(s.mcp.clients).catch(() => undefined);
  // Запись экрана: окно программы само выбирает, какой экран или окно записывать
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const src = sources.find(x => x.id === chosenScreen) || sources.find(x => x.id.startsWith('screen')) || sources[0];
      if (!src) { cb({}); return; }
      cb({ video: src, ...(process.platform === 'win32' && captureAudio ? { audio: 'loopback' as const } : {}) });
    } catch { cb({}); }
  });
  // Проверка обновлений через полминуты после запуска, чтобы не мешать открытию программы
  if (s.autoUpdate && !process.argv.includes('--smoke-test')) setTimeout(() => checkForUpdates().catch(() => undefined), 30000);
});

let chosenScreen = '';
let captureAudio = true;

app.on('window-all-closed', () => app.quit());

// ── Общие сведения ───────────────────────────────────
ipcMain.handle('app:info', async () => ({
  version: app.getVersion(),
  platform: process.platform,
  ffmpeg: ffmpegAvailable(),
  encoders: await hardwareEncoders().catch(() => []),
  videosDir: app.getPath('videos'),
  documentsDir: app.getPath('documents'),
  userData: app.getPath('userData'),
  assetsDir: join(app.getAppPath(), 'dist'),
  pendingOpen: (() => { const p = pendingOpen; pendingOpen = null; return p; })(),
}));
ipcMain.on('app:close-confirmed', () => { allowClose = true; win?.close(); });
ipcMain.handle('app:set-title', (_e, title: string) => win?.setTitle(title));
ipcMain.handle('app:titlebar', (_e, color: string, symbol: string) => {
  try { win?.setTitleBarOverlay?.({ color, symbolColor: symbol, height: 44 }); } catch { /* не на всех системах */ }
});
ipcMain.handle('app:toggle-fullscreen', () => win?.setFullScreen(!win.isFullScreen()));
ipcMain.handle('app:devtools', () => win?.webContents.toggleDevTools());

ipcMain.handle('shell:open-path', (_e, p: string) => shell.openPath(p));
ipcMain.handle('shell:show-item', (_e, p: string) => shell.showItemInFolder(p));
ipcMain.handle('shell:open-external', (_e, url: string) => { if (/^https?:/.test(url)) shell.openExternal(url); });

// ── Настройки ────────────────────────────────────────
ipcMain.handle('settings:get', () => ({ settings: getSettings(), secrets: secretStatus() }));
ipcMain.handle('settings:set', async (_e, patch) => {
  const before = getSettings();
  const s = setSettings(patch);
  if (patch.theme) nativeTheme.themeSource = s.theme;
  if (patch.mcp) {
    if (s.mcp.serverEnabled !== before.mcp.serverEnabled || s.mcp.port !== before.mcp.port) {
      if (s.mcp.serverEnabled) await startMcpServer(s.mcp.port); else stopMcpServer();
    }
    syncClients(s.mcp.clients).catch(() => undefined);
  }
  return s;
});
ipcMain.handle('settings:set-secret', (_e, id: string, value: string) => { setSecret(id, value); return secretStatus(); });

// ── Диалоги ──────────────────────────────────────────
const MEDIA_FILTERS = [
  { name: 'Видео, фото и звук', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv', 'mts', 'm2ts', '3gp', 'flv', 'mpg', 'mpeg', 'ts', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff', 'heic', 'avif', 'mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus', 'wma', 'aiff'] },
  { name: 'Все файлы', extensions: ['*'] },
];
ipcMain.handle('dialog:open-media', async () => {
  const r = await dialog.showOpenDialog(win!, { title: 'Добавить файлы', properties: ['openFile', 'multiSelections'], filters: MEDIA_FILTERS });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('dialog:open-project', async () => {
  const r = await dialog.showOpenDialog(win!, { title: 'Открыть проект', properties: ['openFile'], filters: [{ name: 'Проект «Хлопушка»', extensions: ['kadr'] }] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:save-project', async (_e, name: string) => {
  const dir = join(app.getPath('documents'), 'Хлопушка');
  mkdirSync(dir, { recursive: true });
  const r = await dialog.showSaveDialog(win!, { title: 'Сохранить проект', defaultPath: join(dir, safeName(name) + '.kadr'), filters: [{ name: 'Проект «Хлопушка»', extensions: ['kadr'] }] });
  return r.canceled ? null : r.filePath;
});
ipcMain.handle('dialog:export-path', async (_e, name: string, ext: string) => {
  const s = getSettings();
  const dir = s.exportDir && existsSync(s.exportDir) ? s.exportDir : app.getPath('videos');
  const r = await dialog.showSaveDialog(win!, { title: 'Куда сохранить видео', defaultPath: join(dir, safeName(name) + '.' + ext), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  if (r.canceled || !r.filePath) return null;
  setSettings({ exportDir: dirname(r.filePath) });
  return r.filePath;
});
ipcMain.handle('dialog:relink', async (_e, name: string) => {
  const r = await dialog.showOpenDialog(win!, { title: `Где теперь файл «${name}»?`, properties: ['openFile'], filters: MEDIA_FILTERS });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:open-lut', async () => {
  const r = await dialog.showOpenDialog(win!, { title: 'Выберите LUT-файл', properties: ['openFile'], filters: [{ name: 'LUT (цветовой рецепт)', extensions: ['cube', 'CUBE'] }] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:open-subtitles', async () => {
  const r = await dialog.showOpenDialog(win!, { title: 'Открыть субтитры', properties: ['openFile'], filters: [{ name: 'Субтитры', extensions: ['srt', 'vtt'] }] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:save-text', async (_e, name: string, ext: string, title: string) => {
  const s = getSettings();
  const dir = s.exportDir && existsSync(s.exportDir) ? s.exportDir : app.getPath('videos');
  const r = await dialog.showSaveDialog(win!, { title, defaultPath: join(dir, safeName(name) + '.' + ext), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  return r.canceled || !r.filePath ? null : r.filePath;
});
ipcMain.handle('file:read-text', (_e, path: string) => readFileSync(path, 'utf8'));
ipcMain.handle('file:write-text', (_e, path: string, text: string) => { writeFileSync(path, text, 'utf8'); return true; });
ipcMain.handle('dialog:folder', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

function safeName(n: string) {
  return (n || 'Видео').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
}

// ── Проекты ──────────────────────────────────────────
function addRecent(path: string, name: string) {
  const s = getSettings();
  const recent = [{ path, name, openedAt: Date.now() }, ...s.recent.filter(r => r.path !== path)].slice(0, 12);
  setSettings({ recent });
}
ipcMain.handle('project:read', (_e, path: string) => {
  const project = JSON.parse(readFileSync(path, 'utf8')) as Project;
  for (const m of project.media) m.missing = !existsSync(m.path);
  addRecent(path, project.name);
  return project;
});
ipcMain.handle('project:write', (_e, path: string, project: Project) => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(project, null, 1));
  writeFileSync(path, readFileSync(tmp));
  unlinkSync(tmp);
  addRecent(path, project.name);
  return true;
});
const autosaveDir = () => join(app.getPath('userData'), 'autosave');
ipcMain.handle('project:autosave', (_e, project: Project, savedPath: string | null) => {
  mkdirSync(autosaveDir(), { recursive: true });
  writeFileSync(join(autosaveDir(), project.id + '.kadr'), JSON.stringify({ savedPath, savedAt: Date.now(), project }));
  return true;
});
ipcMain.handle('project:autosaves', () => {
  if (!existsSync(autosaveDir())) return [];
  return readdirSync(autosaveDir()).filter(f => f.endsWith('.kadr')).map(f => {
    try {
      const d = JSON.parse(readFileSync(join(autosaveDir(), f), 'utf8'));
      return { id: d.project.id, name: d.project.name, savedAt: d.savedAt, savedPath: d.savedPath, file: join(autosaveDir(), f) };
    } catch { return null; }
  }).filter(Boolean).sort((a: any, b: any) => b.savedAt - a.savedAt).slice(0, 10);
});
ipcMain.handle('project:read-autosave', (_e, file: string) => JSON.parse(readFileSync(file, 'utf8')));
ipcMain.handle('project:drop-autosave', (_e, id: string) => {
  const f = join(autosaveDir(), id + '.kadr');
  if (existsSync(f)) unlinkSync(f);
});
ipcMain.handle('project:remove-recent', (_e, path: string) => {
  setSettings({ recent: getSettings().recent.filter(r => r.path !== path) });
});

// ── Медиафайлы ───────────────────────────────────────
ipcMain.handle('media:probe', (_e, path: string) => probe(path));
ipcMain.handle('media:thumbs', (_e, path: string, kind, duration: number) => thumbnails(path, kind, duration));
ipcMain.handle('media:waveform', (_e, path: string, duration: number) => waveform(path, duration));
ipcMain.handle('media:silence', (_e, path: string, from: number, to: number, db: number, min: number) => detectSilence(path, from, to, db, min));
ipcMain.handle('media:scenes', (_e, path: string, from: number, to: number, th: number) => detectScenes(path, from, to, th));
ipcMain.handle('media:frame-at', async (_e, path: string, time: number) => {
  const dir = join(app.getPath('documents'), 'Хлопушка', 'Стоп-кадры');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `Кадр ${Date.now()}.png`);
  const r = await run(FFMPEG, ['-hide_banner', '-y', '-ss', String(time), '-i', path, '-frames:v', '1', out]);
  if (r.code !== 0 || !existsSync(out)) throw new Error('Не удалось сохранить кадр');
  return out;
});
ipcMain.handle('media:exists', (_e, path: string) => existsSync(path));

const tempDir = () => { const d = join(tmpdir(), 'kadr'); mkdirSync(d, { recursive: true }); return d; };
function dataUrlToFile(dataUrl: string, file: string) {
  writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
  return file;
}
ipcMain.handle('media:save-recording', async (_e, data: ArrayBuffer, ext: string) => {
  const dir = join(app.getPath('documents'), 'Хлопушка', 'Записи');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const raw = join(tempDir(), `rec_${Date.now()}.${ext}`);
  writeFileSync(raw, Buffer.from(data));
  // запись из браузерного движка не хранит длину файла — пересобираем контейнер, чтобы перемотка работала
  const out = join(dir, `Запись ${stamp}.${ext}`);
  try {
    await run(FFMPEG, ['-hide_banner', '-y', '-i', raw, '-c', 'copy', out]);
    unlinkSync(raw);
    return out;
  } catch {
    writeFileSync(out, readFileSync(raw));
    return out;
  }
});
ipcMain.handle('media:save-image', (_e, dataUrl: string, name: string) => {
  const dir = join(app.getPath('documents'), 'Хлопушка', 'Картинки');
  mkdirSync(dir, { recursive: true });
  return dataUrlToFile(dataUrl, join(dir, safeName(name) + '.png'));
});

// 0.7: логотип, обложка, вставка из буфера обмена и перетаскивание из браузера
ipcMain.handle('dialog:open-image', async (_e, title?: string) => {
  const r = await dialog.showOpenDialog(win!, { title: title || 'Выберите картинку', properties: ['openFile'], filters: [{ name: 'Картинки', extensions: ['png', 'jpg', 'jpeg', 'webp', 'svg', 'gif', 'bmp'] }] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('media:save-image-as', (_e, dataUrl: string, path: string) => dataUrlToFile(dataUrl, path));
const pastedDir = () => { const d = join(app.getPath('documents'), 'Хлопушка', 'Вставки'); mkdirSync(d, { recursive: true }); return d; };
const stampName = (base: string, ext: string) => `${safeName(base).slice(0, 60) || 'Вставка'} ${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}.${ext}`;
const MEDIA_EXT = /\.(mp4|mov|m4v|mkv|webm|avi|png|jpe?g|webp|gif|bmp|mp3|wav|ogg|m4a|aac|flac|opus)$/i;
ipcMain.handle('media:save-bytes', (_e, data: ArrayBuffer, name: string) => {
  const ext = (extname(name).slice(1) || 'png').toLowerCase();
  const file = join(pastedDir(), stampName(name.replace(/\.[^.]+$/, ''), ext));
  writeFileSync(file, Buffer.from(data));
  return file;
});
ipcMain.handle('media:download', async (_e, url: string) => {
  if (!/^https?:\/\//i.test(url)) throw new Error('Это не ссылка на файл');
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Сайт не отдал файл (${r.status})`);
  const type = r.headers.get('content-type') || '';
  if (!/^(image|video|audio)\//.test(type) && !MEDIA_EXT.test(new URL(url).pathname)) throw new Error('По ссылке не картинка, не видео и не звук');
  const fromUrl = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
  const ext = (MEDIA_EXT.exec(fromUrl)?.[1] || type.split('/')[1]?.split(/[;+]/)[0] || 'bin').replace('jpeg', 'jpg').replace('quicktime', 'mov').replace('mpeg', 'mp3');
  const file = join(pastedDir(), stampName(fromUrl.replace(/\.[^.]+$/, '') || 'Из браузера', ext));
  writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return file;
});
// Что лежит в буфере обмена: скопированные в Проводнике файлы, картинка (скриншот) или ссылка.
// Окно программы сначала смотрит само (событие «вставить»), сюда приходит, если там пусто.
ipcMain.handle('clipboard:media', async () => {
  const RAW = 'electron application/osclipboard;format="FileNameW"';
  try {
    const items = await clipboard.read();
    for (const it of items) {
      const fileType = it.types.find(t => t === RAW || t === 'text/uri-list');
      if (fileType) {
        const blob = (await it.getType(fileType)) as Blob;
        const buf = Buffer.from(await blob.arrayBuffer());
        const text = fileType === RAW ? buf.toString('utf16le') : buf.toString('utf8');
        const paths = text.split(/[\0\r\n]+/).map(x => x.trim()).filter(Boolean)
          .map(x => { try { return x.startsWith('file:') ? fileURLToPath(x) : x; } catch { return ''; } })
          .filter(x => x && existsSync(x) && MEDIA_EXT.test(x));
        if (paths.length) return { paths };
      }
      const imgType = it.types.find(t => t.startsWith('image/'));
      if (imgType) {
        const blob = (await it.getType(imgType)) as Blob;
        const file = join(pastedDir(), stampName('Снимок', imgType.includes('jpeg') ? 'jpg' : 'png'));
        writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
        return { paths: [file], image: true };
      }
    }
  } catch { /* буфер занят другой программой или формат незнаком */ }
  const text = (await clipboard.readText().catch(() => '')).trim();
  if (/^https?:\/\/\S+$/i.test(text)) return { url: text };
  return {};
});

// ── Экспорт ──────────────────────────────────────────
const jobs = new Map<string, AbortController>();

type TextPayload = { clipId: string; dataUrl: string; from?: number; to?: number };
function writeTexts(texts: TextPayload[], jobId: string) {
  return texts.map((t, i) => ({ clipId: t.clipId, from: t.from, to: t.to, path: dataUrlToFile(t.dataUrl, join(tempDir(), `${jobId}_t${i}.png`)) }));
}

async function runExport(jobId: string, project: Project, texts: TextPayload[], opts: ExportOptions, onProgress?: (p: number, speed: string) => void) {
  const ctrl = new AbortController();
  jobs.set(jobId, ctrl);
  const textFiles = writeTexts(texts, jobId);
  const temp: string[] = textFiles.map(t => t.path);
  // Прозрачная картинка размером с кадр: паузы между субтитрами в общей ленте
  let blank: string | undefined;
  if (textFiles.length > 1) {
    const b = join(tempDir(), `${jobId}_blank.png`);
    const w = Math.max(2, Math.round(project.width / 2) * 2), h = Math.max(2, Math.round(project.height / 2) * 2);
    const r = await run(FFMPEG, ['-hide_banner', '-y', '-f', 'lavfi', '-i', `color=c=black@0:s=${w}x${h},format=rgba`, '-frames:v', '1', b]);
    if (r.code === 0 && existsSync(b)) { blank = b; temp.push(b); }
  }
  let encoder = opts.encoder;
  if (encoder === 'auto') {
    const hw = (opts.format === 'mp4' || opts.format === 'mov') ? await hardwareEncoders() : [];
    encoder = (hw[0] as ExportOptions['encoder']) || 'cpu';
  }
  const attempt = async (enc: ExportOptions['encoder']) => {
    const plan = buildExportArgs(project, textFiles, { ...opts, encoder: enc }, { tempDir: tempDir(), blank });
    for (const f of plan.files) { writeFileSync(f.path, f.content); temp.push(f.path); }
    const started = Date.now();
    const r = await run(FFMPEG, plan.args, {
      signal: ctrl.signal,
      onStdout: s => {
        const m = [...s.matchAll(/out_time_us=(\d+)/g)].pop();
        const sp = [...s.matchAll(/speed=\s*([\d.]+x)/g)].pop();
        if (m && onProgress) onProgress(Math.min(1, Number(m[1]) / 1e6 / Math.max(0.01, plan.duration)), sp?.[1] || '');
      },
    });
    return { r, seconds: (Date.now() - started) / 1000 };
  };
  try {
    let { r, seconds } = await attempt(encoder);
    if (r.code !== 0 && !ctrl.signal.aborted && encoder !== 'cpu') ({ r, seconds } = await attempt('cpu'));
    if (ctrl.signal.aborted) return { ok: false, canceled: true };
    if (r.code !== 0) return { ok: false, error: lastError(r.stderr) };
    return { ok: true, outPath: opts.outPath, seconds, encoder };
  } finally {
    jobs.delete(jobId);
    for (const t of temp) try { unlinkSync(t); } catch { /* уже удалён */ }
  }
}

function lastError(stderr: string) {
  const lines = stderr.trim().split('\n').filter(l => /error|invalid|failed|no such|not/i.test(l));
  return (lines.slice(-3).join('\n') || stderr.trim().split('\n').slice(-3).join('\n')).slice(0, 800);
}

ipcMain.handle('export:start', async (_e, jobId: string, project: Project, texts, opts: ExportOptions) => {
  if (opts.encoder === 'auto' && getSettings().encoder !== 'auto') opts.encoder = getSettings().encoder;
  try { mkdirSync(dirname(opts.outPath), { recursive: true }); } catch { /* ошибку покажет FFmpeg */ }
  let last = 0;
  const res = await runExport(jobId, project, texts, opts, (p, speed) => {
    const now = Date.now();
    if (now - last > 150 || p >= 1) { last = now; notify('export:progress', { jobId, progress: p, speed }); }
  });
  win?.setProgressBar(-1);
  return res;
});
ipcMain.handle('export:cancel', (_e, jobId: string) => jobs.get(jobId)?.abort());
ipcMain.handle('export:taskbar', (_e, p: number) => win?.setProgressBar(p));

ipcMain.handle('render:frame', async (_e, project: Project, texts, time: number, width: number) => {
  const id = 'f' + Date.now();
  const out = join(tempDir(), id + '.jpg');
  const scale = Math.min(1, width / project.width);
  const res = await runExport(id, project, texts, {
    outPath: out, format: 'png', width: Math.round(project.width * scale), height: Math.round(project.height * scale),
    fps: project.fps, quality: 'good', encoder: 'cpu', rangeStart: time,
  });
  if (!res.ok || !existsSync(out)) throw new Error(res.error || 'Кадр не получился');
  const b64 = readFileSync(out).toString('base64');
  unlinkSync(out);
  return b64;
});

// Распознавание речи: сводим звук проекта и отправляем в сервис
ipcMain.handle('ai:transcribe', async (_e, project: Project, range?: { start: number; end: number }, language?: string, fillers?: boolean) => {
  const id = 's' + Date.now();
  const out = join(tempDir(), id + '.mp3');
  const plan = buildExportArgs(project, [], {
    outPath: out, format: 'mp3', width: project.width, height: project.height, fps: project.fps, quality: 'draft', encoder: 'cpu',
    rangeStart: range?.start, rangeEnd: range?.end,
  });
  const args = [...plan.args];
  const bi = args.indexOf('-b:a');
  if (bi >= 0) args[bi + 1] = '48k';
  args.splice(args.length - 1, 0, '-ac', '1', '-ar', '16000');
  const r = await run(FFMPEG, args);
  if (r.code !== 0) throw new Error('Не удалось подготовить звук: ' + lastError(r.stderr));
  try {
    const segs = await transcribeFile(out, language, !!fillers);
    const offset = range?.start || 0;
    const total = projectDuration(project);
    return segs.map(s => ({
      ...s, start: s.start + offset, end: Math.min(s.end + offset, total),
      words: s.words?.map(w => ({ ...w, s: w.s + offset, e: Math.min(w.e + offset, total) })),
    }));
  } finally {
    try { unlinkSync(out); } catch { /* ок */ }
  }
});

// Распознавание речи одного файла для монтажа через текст. Длинные записи идут кусками по 10 минут,
// чтобы не упереться в ограничение сервиса на размер файла.
const transcribeJobs = new Map<string, AbortController>();
ipcMain.handle('ai:transcribe-media-cancel', (_e, jobId: string) => transcribeJobs.get(jobId)?.abort());
ipcMain.handle('ai:transcribe-media', async (_e, jobId: string, path: string, duration: number, language?: string) => {
  const ctrl = new AbortController();
  transcribeJobs.set(jobId, ctrl);
  const step = 600;
  const parts = Math.max(1, Math.ceil(duration / step - 1e-6));
  const words: { s: number; e: number; w: string }[] = [];
  try {
    for (let i = 0; i < parts; i++) {
      if (ctrl.signal.aborted) throw new Error('Отменено');
      notify('ai:transcribe-progress', { jobId, progress: i / parts });
      const from = i * step, len = Math.min(step, duration - from);
      if (len < 0.3) break;
      const out = join(tempDir(), `tm_${jobId}_${i}.mp3`);
      const r = await run(FFMPEG, ['-hide_banner', '-y', '-nostdin', '-ss', String(from), '-t', String(len), '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', out], { signal: ctrl.signal });
      if (ctrl.signal.aborted) throw new Error('Отменено');
      if (r.code !== 0) throw new Error('Не удалось подготовить звук: ' + lastError(r.stderr));
      try {
        const segs = await transcribeFile(out, language, true);
        for (const seg of segs) {
          const list = seg.words?.length ? seg.words : estimateWords(seg.text, seg.start, seg.end);
          for (const w of list) words.push({ s: +(w.s + from).toFixed(3), e: +(Math.min(w.e, len) + from).toFixed(3), w: w.w });
        }
      } finally {
        try { unlinkSync(out); } catch { /* ок */ }
      }
    }
    // на стыке фраз сервис иногда повторяет слово — оставляем одно
    words.sort((a, b) => a.s - b.s);
    return words.filter((w, i) => !i || !(Math.abs(w.s - words[i - 1].s) < 0.02 && w.w === words[i - 1].w));
  } finally {
    transcribeJobs.delete(jobId);
  }
});

// Доли в музыке: звук в виде чисел и поиск ударов
ipcMain.handle('media:beats', async (_e, path: string, from: number, to: number) => {
  const sr = 11025;
  const samples = await pcm(path, sr, from, Math.max(0.5, to - from));
  const r = detectBeats(samples, sr);
  return { ...r, beats: r.beats.map(b => b + from) };
});

// Лёгкие копии для плавного просмотра
ipcMain.handle('media:proxy', (_e, jobId: string, path: string, duration: number) =>
  makeProxy(jobId, path, duration, p => notify('media:process-progress', { jobId, progress: p })));

// ── ИИ и MCP ─────────────────────────────────────────
ipcMain.handle('ai:chat', (_e, sessionId: string, text: string, images: string[]) => { chat(sessionId, text, images); return true; });
ipcMain.handle('ai:stop', () => stopAi());
ipcMain.handle('ai:reset', (_e, sessionId: string) => resetSession(sessionId));
ipcMain.handle('ai:models', (_e, providerId: string, baseUrl?: string) => listModels(providerId, baseUrl));
ipcMain.handle('ai:complete', (_e, system: string, user: string) => complete(system, user));

// ── Обработка клипов, звук, запись экрана, обновления ──
ipcMain.handle('media:process', (_e, jobId: string, kind: ProcessKind, path: string, from: number, to: number) =>
  processClip(jobId, kind, path, from, to, p => notify('media:process-progress', { jobId, progress: p })));
ipcMain.handle('media:process-cancel', (_e, jobId: string) => cancelProcess(jobId));
// Удаление фона: подготовка кадров, обмен кадрами и масками с окном программы, сборка видео
ipcMain.handle('nobg:prepare', (_e, jobId: string, path: string, from: number, to: number, w: number, h: number, fps: number) => bgPrepare(jobId, path, from, to, w, h, fps));
ipcMain.handle('nobg:frames', (_e, jobId: string, start: number, count: number) => bgFrames(jobId, start, count));
ipcMain.handle('nobg:write', (_e, jobId: string, masks: Uint8Array) => bgWrite(jobId, masks));
ipcMain.handle('nobg:finish', (_e, jobId: string) => bgFinish(jobId, p => notify('media:process-progress', { jobId, progress: p })));
ipcMain.handle('nobg:cancel', (_e, jobId: string) => { cancelProcess(jobId); bgCleanup(jobId); });
ipcMain.handle('audio:snippet', (_e, project: Project, start: number, end: number) => audioSnippet(project, start, end));
ipcMain.handle('audio:loudness', (_e, project: Project) => measureLoudness(project));
ipcMain.handle('screen:sources', async () => {
  const list = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
  return list.filter(s => !/^Кадр$|^Kadr$/.test(s.name)).map(s => ({ id: s.id, name: s.id.startsWith('screen') ? (list.filter(x => x.id.startsWith('screen')).length > 1 ? s.name : 'Весь экран') : s.name, screen: s.id.startsWith('screen'), thumb: s.thumbnail.toDataURL() }));
});
ipcMain.handle('screen:choose', (_e, id: string, audio: boolean) => { chosenScreen = id; captureAudio = audio; });
ipcMain.handle('app:minimize', () => win?.minimize());
ipcMain.handle('app:restore', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
ipcMain.handle('update:check', () => checkForUpdates());
ipcMain.handle('update:download', () => downloadUpdate());
ipcMain.handle('update:state', () => updateState());
ipcMain.handle('update:install', () => { allowClose = true; installUpdate(); });
ipcMain.handle('mcp:status', () => ({ server: mcpServerState(), clients: clientStatus() }));
ipcMain.handle('gen:image', (_e, prompt: string, aspect, provider?: string) => generateImage(prompt, aspect, provider));
ipcMain.handle('gen:speech', (_e, text: string, voiceId?: string, model?: string) => generateSpeech(text, voiceId, model));
ipcMain.handle('gen:sfx', (_e, prompt: string, duration?: number) => generateSoundEffect(prompt, duration));
ipcMain.handle('gen:music', (_e, prompt: string, duration?: number, instrumental?: boolean) => generateMusic(prompt, duration, instrumental));
ipcMain.handle('gen:voices', () => listVoices());
ipcMain.handle('gen:video', (e, jobId: string, prompt: string, o) => generateVideo(jobId, prompt, o, text => e.sender.send('gen:video-status', { jobId, text })));
ipcMain.handle('gen:video-cancel', (_e, jobId: string) => cancelVideo(jobId));
ipcMain.handle('mcp:desktop-status', () => desktopStatus(getSettings().mcp.port));
ipcMain.handle('mcp:desktop-connect', () => connectClaudeDesktop(getSettings().mcp.port));
ipcMain.handle('mcp:desktop-entry', () => desktopEntry(getSettings().mcp.port));
ipcMain.handle('mcp:restart', async () => {
  const s = getSettings();
  if (s.mcp.serverEnabled) await startMcpServer(s.mcp.port);
  await syncClients(s.mcp.clients);
  return { server: mcpServerState(), clients: clientStatus() };
});

// Пример проекта для первого знакомства: генерируем ролики прямо через FFmpeg
ipcMain.handle('app:sample-media', async () => {
  const dir = join(app.getPath('documents'), 'Хлопушка', 'Примеры');
  mkdirSync(dir, { recursive: true });
  const files = [
    { name: 'Пример 1 — закат.mp4', args: ['-f', 'lavfi', '-i', 'gradients=s=1920x1080:c0=0xff7a3d:c1=0x7c5cff:x0=0:y0=0:x1=1920:y1=1080:speed=0.02:d=6:r=30', '-f', 'lavfi', '-i', 'sine=f=220:d=6', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'] },
    { name: 'Пример 2 — океан.mp4', args: ['-f', 'lavfi', '-i', 'gradients=s=1920x1080:c0=0x0ea5e9:c1=0x14b8a6:c2=0x1e3a8a:n=3:speed=0.03:d=6:r=30', '-f', 'lavfi', '-i', 'sine=f=330:d=6', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'] },
    { name: 'Пример 3 — сетка.mp4', args: ['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'] },
    { name: 'Музыка — спокойная.mp3', args: ['-f', 'lavfi', '-i', 'aevalsrc=0.15*sin(2*PI*220*t)*(1+0.5*sin(2*PI*0.5*t))+0.1*sin(2*PI*330*t):s=44100:d=20', '-c:a', 'libmp3lame'] },
  ];
  const out: string[] = [];
  for (const f of files) {
    const p = join(dir, f.name);
    if (!existsSync(p)) await run(FFMPEG, ['-hide_banner', '-y', ...f.args, p]);
    if (existsSync(p)) out.push(p);
  }
  return out;
});

