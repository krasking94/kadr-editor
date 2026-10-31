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
    const long = ['export_video', 'transcribe', 'remove_silence', 'detect_scenes', 'import_media', 'get_frame', 'stabilize_clip', 'reverse_clip', 'auto_reframe',
      'remove_fillers', 'make_subtitles', 'translate_subtitles', 'analyze_audio', 'add_sticker', 'get_transcript', 'shorten_pauses', 'find_shorts', 'make_shorts', 'beat_sync', 'export_formats', 'separate_voice', 'auto_draft', 'preflight_check',
      'remove_background', 'blur_faces', 'fit_music', 'speed_ramp', 'group_clips', 'create_multicam', 'track_object', 'make_cover', 'auto_color', 'cut_transcript', 'studio_voice'].includes(name) || name.startsWith('generate_');
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
