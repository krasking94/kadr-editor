// Доступ к возможностям компьютера (файлы, FFmpeg, ИИ) из окна программы
import type { KadrApi } from '../electron/preload';

declare global {
  interface Window { kadr: KadrApi }
}

export const api = window.kadr;

export const mediaUrl = (path: string) => 'kadr-media://local/' + encodeURIComponent(path);

export interface AppInfo {
  version: string;
  platform: string;
  ffmpeg: { ok: boolean; version: string };
  encoders: string[];
  videosDir: string;
  documentsDir: string;
  userData: string;
  pendingOpen: string | null;
}
