// Публикация в один клик (с 0.9): готовое видео уходит в YouTube, ВКонтакте и Telegram
// вместе с названием, описанием и обложкой. Ключи и входы в аккаунты хранятся зашифрованными, как ключи нейросетей.
import { BrowserWindow, shell } from 'electron';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { openSync, readSync, closeSync, readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { getSecret, getSettings, setSecret } from './settings';
import { log } from './crash';

export type Platform = 'youtube' | 'vk' | 'telegram';

export interface PublishRequest {
  file: string;
  title: string;
  description: string;
  tags: string[];
  cover?: string; // картинка-обложка (PNG или JPG)
  privacy?: 'private' | 'unlisted' | 'public'; // YouTube
  width?: number; height?: number; duration?: number;
}

export interface PublishResult { platform: Platform; ok: boolean; url?: string; error?: string; warning?: string }

type Progress = (platform: Platform, k: number, text?: string) => void;

const mimeOf = (f: string) => ({ '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' } as Record<string, string>)[extname(f).toLowerCase()] || 'application/octet-stream';

async function errorText(r: Response, service: string) {
  const body = (await r.text().catch(() => '')).slice(0, 500);
  if (r.status === 401 || r.status === 403) return `${service}: нет доступа (${r.status}). Войдите в аккаунт заново в Настройки → Публикация. ${body}`;
  if (r.status === 413) return `${service}: файл слишком большой.`;
  return `${service}: ошибка ${r.status}. ${body}`;
}

// ── Telegram ──────────────────────────────────────────
// Видео отправляет бот, которого человек сделал у @BotFather и добавил администратором в свой канал
export async function telegramSend(req: PublishRequest, onProgress: Progress): Promise<PublishResult> {
  const token = getSecret('telegram-bot');
  const chat = getSettings().publish.telegramChat.trim();
  if (!token || !chat) return { platform: 'telegram', ok: false, error: 'Telegram не подключён: укажите токен бота и канал в Настройки → Публикация' };
  const size = statSync(req.file).size;
  if (size > 50 * 1024 * 1024) return { platform: 'telegram', ok: false, error: `Бот Telegram принимает видео до 50 МБ, а файл — ${Math.round(size / 1048576)} МБ. Сохраните видео в качестве «Хорошее» или покороче.` };
  onProgress('telegram', 0.05, 'Отправляю в Telegram');
  const form = new FormData();
  form.set('chat_id', chat);
  const caption = [req.title, req.description, req.tags.length ? req.tags.map(t => '#' + t.replace(/^#/, '').replace(/\s+/g, '_')).join(' ') : ''].filter(Boolean).join('\n\n');
  form.set('caption', caption.slice(0, 1024));
  form.set('supports_streaming', 'true');
  if (req.width) form.set('width', String(req.width));
  if (req.height) form.set('height', String(req.height));
  if (req.duration) form.set('duration', String(Math.round(req.duration)));
  form.set('video', new Blob([readFileSync(req.file)], { type: mimeOf(req.file) }), basename(req.file));
  if (req.cover) form.set('cover', new Blob([readFileSync(req.cover)], { type: mimeOf(req.cover) }), basename(req.cover));
  const r = await fetch(`https://api.telegram.org/bot${token}/sendVideo`, { method: 'POST', body: form });
  const j = await r.json().catch(() => ({})) as { ok?: boolean; description?: string; result?: { message_id: number; chat: { username?: string; id: number } } };
  if (!j.ok) return { platform: 'telegram', ok: false, error: `Telegram: ${j.description || r.status}. Проверьте, что бот — администратор канала.` };
  onProgress('telegram', 1);
  const user = j.result?.chat.username;
  return { platform: 'telegram', ok: true, url: user ? `https://t.me/${user}/${j.result!.message_id}` : undefined };
}

export async function telegramCheck(): Promise<string> {
  const token = getSecret('telegram-bot');
  if (!token) throw new Error('Нет токена бота');
  const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const j = await r.json().catch(() => ({})) as { ok?: boolean; result?: { username: string } };
  if (!j.ok) throw new Error('Токен бота не подходит');
  return '@' + j.result!.username;
}

// ── YouTube ───────────────────────────────────────────
// Вход через Google в браузере (OAuth с PKCE и возвратом на 127.0.0.1). Нужен «клиент OAuth для компьютера»
// из Google Cloud: его ID и секрет вставляются в Настройки → Публикация один раз.
const YT_SCOPE = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly';

export async function youtubeLogin(): Promise<string> {
  const clientId = getSettings().publish.youtubeClientId.trim();
  const secret = getSecret('youtube-secret');
  if (!clientId) throw new Error('Сначала вставьте ID клиента Google (Настройки → Публикация → YouTube)');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(12).toString('hex');
  const { code, redirect } = await new Promise<{ code: string; redirect: string }>((resolve, reject) => {
    const srv = createServer((req, res) => {
      const u = new URL(req.url || '/', 'http://127.0.0.1');
      const c = u.searchParams.get('code'), st = u.searchParams.get('state'), err = u.searchParams.get('error');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<html><body style="font-family:sans-serif;background:#111;color:#eee;display:grid;place-items:center;height:100vh"><div><h2>${c ? 'Готово! Вернитесь в «Хлопушку»' : 'Вход не удался'}</h2><p>Это окно можно закрыть.</p></div></body></html>`);
      clearTimeout(timer);
      srv.close();
      if (c && st === state) resolve({ code: c, redirect: `http://127.0.0.1:${port}` });
      else reject(new Error(err === 'access_denied' ? 'Вход отменён' : 'Google не прислал код входа'));
    });
    let port = 0;
    const timer = setTimeout(() => { srv.close(); reject(new Error('Время на вход вышло (5 минут)')); }, 5 * 60_000);
    srv.listen(0, '127.0.0.1', () => {
      port = (srv.address() as { port: number }).port;
      const q = new URLSearchParams({
        client_id: clientId, redirect_uri: `http://127.0.0.1:${port}`, response_type: 'code', scope: YT_SCOPE,
        access_type: 'offline', prompt: 'consent', code_challenge: challenge, code_challenge_method: 'S256', state,
      });
      shell.openExternal('https://accounts.google.com/o/oauth2/v2/auth?' + q);
    });
  });
  const body = new URLSearchParams({ client_id: clientId, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirect, ...(secret ? { client_secret: secret } : {}) });
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body });
  const j = await r.json().catch(() => ({})) as { refresh_token?: string; access_token?: string; error_description?: string };
  if (!j.refresh_token) throw new Error('Google не выдал доступ: ' + (j.error_description || r.status));
  setSecret('youtube-refresh', j.refresh_token);
  return youtubeChannel(j.access_token!).catch(() => 'YouTube подключён');
}

async function youtubeToken(): Promise<string> {
  const refresh = getSecret('youtube-refresh');
  if (!refresh) throw new Error('YouTube не подключён: войдите в Настройки → Публикация');
  const secret = getSecret('youtube-secret');
  const body = new URLSearchParams({ client_id: getSettings().publish.youtubeClientId.trim(), refresh_token: refresh, grant_type: 'refresh_token', ...(secret ? { client_secret: secret } : {}) });
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body });
  const j = await r.json().catch(() => ({})) as { access_token?: string; error?: string };
  if (!j.access_token) {
    if (j.error === 'invalid_grant') setSecret('youtube-refresh', '');
    throw new Error('YouTube: вход устарел, войдите заново в Настройки → Публикация');
  }
  return j.access_token;
}

async function youtubeChannel(token: string): Promise<string> {
  const r = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { authorization: 'Bearer ' + token } });
  const j = await r.json() as { items?: { snippet: { title: string } }[] };
  return j.items?.[0]?.snippet.title || 'YouTube подключён';
}

export async function youtubeUpload(req: PublishRequest, onProgress: Progress): Promise<PublishResult> {
  let token: string;
  try { token = await youtubeToken(); } catch (e) { return { platform: 'youtube', ok: false, error: (e as Error).message }; }
  const size = statSync(req.file).size;
  const meta = {
    snippet: { title: req.title.slice(0, 100) || basename(req.file, extname(req.file)), description: req.description.slice(0, 5000), tags: req.tags.slice(0, 30), categoryId: '22' },
    status: { privacyStatus: req.privacy || 'private', selfDeclaredMadeForKids: false },
  };
  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-length': String(size), 'x-upload-content-type': mimeOf(req.file) },
    body: JSON.stringify(meta),
  });
  if (!init.ok) return { platform: 'youtube', ok: false, error: await errorText(init, 'YouTube') };
  const url = init.headers.get('location');
  if (!url) return { platform: 'youtube', ok: false, error: 'YouTube не дал адрес для загрузки' };
  // кусками по 8 МБ: видно, сколько загружено, и большой файл не занимает всю память
  const CH = 8 * 1024 * 1024;
  const fd = openSync(req.file, 'r');
  let videoId = '';
  try {
    for (let off = 0; off < size; off += CH) {
      const len = Math.min(CH, size - off);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, off);
      const r = await fetch(url, { method: 'PUT', headers: { 'content-length': String(len), 'content-range': `bytes ${off}-${off + len - 1}/${size}` }, body: buf });
      if (r.status === 308) { onProgress('youtube', (off + len) / size * 0.95, 'Загружаю на YouTube'); continue; }
      if (!r.ok) return { platform: 'youtube', ok: false, error: await errorText(r, 'YouTube') };
      videoId = ((await r.json()) as { id: string }).id;
    }
  } finally { closeSync(fd); }
  if (!videoId) return { platform: 'youtube', ok: false, error: 'YouTube не подтвердил загрузку' };
  let warning: string | undefined;
  if (req.cover) {
    const r = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}`, {
      method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': mimeOf(req.cover) }, body: readFileSync(req.cover),
    });
    if (!r.ok) warning = 'Обложку YouTube не принял: свои обложки доступны после подтверждения канала по телефону (youtube.com/verify).';
  }
  onProgress('youtube', 1);
  return { platform: 'youtube', ok: true, url: `https://youtu.be/${videoId}`, warning };
}

// ── ВКонтакте ─────────────────────────────────────────
// Вход через окно ВК (Standalone-приложение): ID приложения вставляется в Настройки → Публикация.
export async function vkLogin(): Promise<string> {
  const appId = getSettings().publish.vkAppId.trim();
  if (!appId) throw new Error('Сначала вставьте ID приложения ВК (Настройки → Публикация → ВКонтакте)');
  const token = await new Promise<string>((resolve, reject) => {
    const w = new BrowserWindow({ width: 680, height: 720, title: 'Вход во ВКонтакте', autoHideMenuBar: true, webPreferences: { partition: 'persist:vk', sandbox: true } });
    let done = false;
    const check = (url: string) => {
      if (!url.startsWith('https://oauth.vk.com/blank.html')) return;
      const h = new URLSearchParams(url.split('#')[1] || '');
      const t = h.get('access_token');
      done = true;
      w.close();
      if (t) resolve(t); else reject(new Error(h.get('error_description') || 'Вход отменён'));
    };
    w.webContents.on('will-redirect', (_e, url) => check(url));
    w.webContents.on('did-navigate', (_e, url) => check(url));
    w.on('closed', () => { if (!done) reject(new Error('Вход отменён')); });
    const q = new URLSearchParams({ client_id: appId, display: 'page', redirect_uri: 'https://oauth.vk.com/blank.html', scope: 'video,offline,groups', response_type: 'token', v: '5.199' });
    w.loadURL('https://oauth.vk.com/authorize?' + q);
  });
  setSecret('vk-token', token);
  return vkUser().catch(() => 'ВКонтакте подключён');
}

async function vkApi<T>(method: string, params: Record<string, string>): Promise<T> {
  const token = getSecret('vk-token');
  if (!token) throw new Error('ВКонтакте не подключён: войдите в Настройки → Публикация');
  const r = await fetch(`https://api.vk.com/method/${method}`, { method: 'POST', body: new URLSearchParams({ ...params, access_token: token, v: '5.199' }) });
  const j = await r.json() as { response?: T; error?: { error_msg: string; error_code: number } };
  if (j.error) {
    if (j.error.error_code === 5) setSecret('vk-token', '');
    throw new Error(`ВКонтакте: ${j.error.error_msg}`);
  }
  return j.response as T;
}

async function vkUser(): Promise<string> {
  const u = await vkApi<{ first_name: string; last_name: string }[]>('users.get', {});
  return `${u[0].first_name} ${u[0].last_name}`;
}

export async function vkUpload(req: PublishRequest, onProgress: Progress): Promise<PublishResult> {
  try {
    const group = getSettings().publish.vkGroupId.trim().replace(/^-/, '').replace(/^club/, '');
    onProgress('vk', 0.05, 'Отправляю во ВКонтакте');
    const save = await vkApi<{ upload_url: string; video_id: number; owner_id: number }>('video.save', {
      name: req.title.slice(0, 128), description: [req.description, req.tags.map(t => '#' + t.replace(/^#/, '').replace(/\s+/g, '_')).join(' ')].filter(Boolean).join('\n\n').slice(0, 5000),
      ...(group ? { group_id: group } : {}), wallpost: '0',
    });
    const form = new FormData();
    form.set('video_file', new Blob([readFileSync(req.file)], { type: mimeOf(req.file) }), basename(req.file));
    const r = await fetch(save.upload_url, { method: 'POST', body: form });
    if (!r.ok) return { platform: 'vk', ok: false, error: await errorText(r, 'ВКонтакте') };
    const j = await r.json().catch(() => ({})) as { video_id?: number; owner_id?: number; error?: string };
    if (j.error) return { platform: 'vk', ok: false, error: 'ВКонтакте: ' + j.error };
    onProgress('vk', 1);
    return { platform: 'vk', ok: true, url: `https://vk.com/video${j.owner_id ?? save.owner_id}_${j.video_id ?? save.video_id}`, warning: req.cover ? 'Обложку ВК подберёт сам — свою можно поставить на сайте в настройках видео.' : undefined };
  } catch (e) {
    return { platform: 'vk', ok: false, error: (e as Error).message };
  }
}

export async function publish(req: PublishRequest, platforms: Platform[], onProgress: Progress): Promise<PublishResult[]> {
  const out: PublishResult[] = [];
  for (const p of platforms) {
    let r: PublishResult;
    try {
      r = p === 'youtube' ? await youtubeUpload(req, onProgress) : p === 'vk' ? await vkUpload(req, onProgress) : await telegramSend(req, onProgress);
    } catch (e) {
      r = { platform: p, ok: false, error: `Нет связи с ${p === 'youtube' ? 'YouTube' : p === 'vk' ? 'ВКонтакте' : 'Telegram'}: ${(e as Error).message}` };
    }
    log(`Публикация ${p}: ${r.ok ? 'готово ' + (r.url || '') : 'ошибка ' + r.error}`);
    out.push(r);
  }
  return out;
}

export function publishStatus(): Record<Platform, boolean> {
  const s = getSettings().publish;
  return { youtube: !!getSecret('youtube-refresh'), vk: !!getSecret('vk-token'), telegram: !!getSecret('telegram-bot') && !!s.telegramChat.trim() };
}

export function publishLogout(p: Platform) {
  if (p === 'youtube') setSecret('youtube-refresh', '');
  if (p === 'vk') setSecret('vk-token', '');
  if (p === 'telegram') setSecret('telegram-bot', '');
}
