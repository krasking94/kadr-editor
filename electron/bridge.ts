// Мост между ИИ (помощник или внешний MCP-клиент) и окном редактора, где живёт проект.
import { BrowserWindow, ipcMain } from 'electron';

export interface ToolOutput {
  text: string;
  image?: string; // JPEG в base64
  isError?: boolean;
}

let win: BrowserWindow | null = null;
let seq = 0;
const pending = new Map<number, (r: ToolOutput) => void>();

export function attachWindow(w: BrowserWindow): void {
  win = w;
}

ipcMain.on('tool:result', (_e, id: number, result: ToolOutput) => {
  pending.get(id)?.(result);
  pending.delete(id);
});

export function callEditor(name: string, args: unknown, source: string): Promise<ToolOutput> {
  if (!win || win.isDestroyed()) return Promise.resolve({ text: 'Окно редактора закрыто', isError: true });
  const id = ++seq;
  return new Promise(resolve => {
    const long = ['export_video', 'transcribe', 'remove_silence', 'detect_scenes', 'import_media', 'get_frame'].includes(name) || name.startsWith('generate_');
    const timer = setTimeout(() => {
      if (pending.delete(id)) resolve({ text: 'Редактор не ответил вовремя', isError: true });
    }, long ? 30 * 60_000 : 60_000);
    pending.set(id, r => { clearTimeout(timer); resolve(r); });
    win!.webContents.send('tool:call', { id, name, args: args ?? {}, source });
  });
}

export function notify(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
