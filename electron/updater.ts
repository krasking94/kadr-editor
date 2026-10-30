// Автообновление: «Кадр» сам узнаёт о новой версии на GitHub, скачивает её по согласию пользователя
// и ставит при перезапуске. Работает в установленной версии (Kadr-Setup), не в архиве ZIP.
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { notify } from './bridge';

let state: { status: 'idle' | 'checking' | 'available' | 'none' | 'downloading' | 'ready' | 'error' | 'unsupported'; version?: string; progress?: number; error?: string; notes?: string } = { status: 'idle' };
let wired = false;

const send = (patch: Partial<typeof state>) => {
  state = { ...state, ...patch };
  notify('update:state', state);
};

function wire() {
  if (wired) return;
  wired = true;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => send({ status: 'checking', error: undefined }));
  autoUpdater.on('update-available', info => send({ status: 'available', version: info.version, notes: typeof info.releaseNotes === 'string' ? info.releaseNotes.replace(/<[^>]+>/g, '').slice(0, 1500) : undefined }));
  autoUpdater.on('update-not-available', () => send({ status: 'none' }));
  autoUpdater.on('download-progress', p => send({ status: 'downloading', progress: p.percent / 100 }));
  autoUpdater.on('update-downloaded', info => send({ status: 'ready', version: info.version, progress: 1 }));
  autoUpdater.on('error', e => send({ status: 'error', error: String(e?.message || e).split('\n')[0].slice(0, 300) }));
}

// Обновление возможно только в установленной программе (у ZIP-версии и при разработке его нет)
const supported = () => app.isPackaged && process.platform === 'win32' && !process.env.PORTABLE_EXECUTABLE_DIR;

export async function checkForUpdates(): Promise<typeof state> {
  if (!supported()) { send({ status: 'unsupported' }); return state; }
  wire();
  try { await autoUpdater.checkForUpdates(); } catch (e) { send({ status: 'error', error: String((e as Error).message || e).split('\n')[0] }); }
  return state;
}

export async function downloadUpdate(): Promise<void> {
  if (!supported()) return;
  wire();
  send({ status: 'downloading', progress: 0 });
  try { await autoUpdater.downloadUpdate(); } catch (e) { send({ status: 'error', error: String((e as Error).message || e).split('\n')[0] }); }
}

export function installUpdate(): void {
  if (state.status === 'ready') autoUpdater.quitAndInstall(false, true);
}

export const updateState = () => state;
