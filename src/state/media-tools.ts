// Версия 0.3: лёгкие копии тяжёлых видео для плавного просмотра и склейка под ритм музыки.
import { api } from '../api';
import type { MediaClip, MediaItem } from '../../shared/types';
import { clipDuration, clipEnd, findClip, layoutMain, mainTrack, mediaById, uid } from '../../shared/timeline';
import { fitToBeats } from '../../shared/beats';
import { commit, endTask, get, patchMediaEverywhere, startTask, toast, updateTask } from './store';

const clean = (e: unknown) => String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// ── Лёгкие копии ─────────────────────────────────────
/** Тяжёлое ли видео для просмотра: больше 2K или очень высокий битрейт */
export function isHeavy(m: MediaItem): boolean {
  if (m.kind !== 'video') return false;
  const bitrate = m.duration > 0 ? (m.size * 8) / m.duration : 0;
  return Math.max(m.width, m.height) > 2000 || bitrate > 40e6;
}

/** Путь, который показывает окно просмотра: лёгкая копия, если она есть и включена */
export function previewPath(m: MediaItem, useProxy: boolean): string {
  return useProxy && m.proxy ? m.proxy : m.path;
}

const proxyQueue: string[] = [];
let proxyRunning = false;
export const proxyBusy = new Set<string>();

export function requestProxies(ids: string[]) {
  for (const id of ids) if (!proxyQueue.includes(id) && !proxyBusy.has(id)) proxyQueue.push(id);
  pumpProxies();
}

async function pumpProxies() {
  if (proxyRunning) return;
  proxyRunning = true;
  try {
    while (proxyQueue.length) {
      const id = proxyQueue.shift()!;
      const m = get().project?.media.find(x => x.id === id);
      if (!m || m.kind !== 'video' || m.missing || m.proxy) continue;
      proxyBusy.add(id);
      const jobId = 'x' + Date.now();
      const task = startTask(`Лёгкая копия: ${m.name}`, () => { proxyQueue.length = 0; api.processCancel(jobId); });
      const off = api.onProcessProgress((ev: { jobId: string; progress: number }) => { if (ev.jobId === jobId) updateTask(task, { progress: ev.progress }); });
      try {
        const path: string = await api.makeProxy(jobId, m.path, m.duration);
        patchMediaEverywhere(id, { proxy: path });
      } catch (e) {
        const msg = clean(e);
        if (msg !== 'Отменено') toast('error', 'Не удалось сделать лёгкую копию', { detail: msg });
      } finally {
        off();
        endTask(task);
        proxyBusy.delete(id);
      }
    }
  } finally {
    proxyRunning = false;
  }
}

/** После добавления файлов: тяжёлым видео сразу делаем лёгкие копии (если не выключено в настройках) */
export function autoProxies(media: MediaItem[]) {
  if (get().settings.proxy === 'off') return;
  const heavy = media.filter(m => isHeavy(m) && !m.proxy);
  if (!heavy.length) return;
  toast('info', 'Делаю лёгкие копии тяжёлых видео', { detail: 'Просмотр станет плавным, а сохранится всё равно оригинал в полном качестве.', ttl: 6000 });
  requestProxies(heavy.map(m => m.id));
}

export function dropProxy(id: string) {
  patchMediaEverywhere(id, { proxy: undefined });
}

/** При открытии проекта лёгкие копии могли пропасть (почистили папку) — забываем о них */
export async function checkProxies() {
  for (const m of get().project?.media || []) {
    if (m.proxy && !(await api.exists(m.proxy))) dropProxy(m.id);
  }
}

// ── Склейка под ритм музыки ──────────────────────────
export interface Beats { clipId: string; bpm: number; times: number[]; downbeat: number } // times — на таймлайне

/** Музыкальный клип для ритма: выбранный или первый на звуковых дорожках */
export function musicClip(): MediaClip | null {
  const p = get().project!;
  const sel = get().selection.map(id => findClip(p, id)?.clip).find((c): c is MediaClip => c?.type === 'media' && mediaById(p, c.mediaId)?.kind === 'audio');
  if (sel) return sel;
  for (const t of p.tracks) if (t.kind === 'audio') for (const c of t.clips) if (c.type === 'media') return c;
  return null;
}

export async function findBeats(clipId?: string): Promise<Beats | null> {
  const p = get().project!;
  const c = clipId ? (findClip(p, clipId)?.clip as MediaClip | undefined) : musicClip();
  if (!c || c.type !== 'media') { toast('info', 'Добавьте музыку на звуковую дорожку', { detail: 'Ритм ищется в музыке: перетащите трек вниз, на дорожку «Музыка».' }); return null; }
  const m = mediaById(p, c.mediaId);
  if (!m?.hasAudio) { toast('info', 'В этом клипе нет звука'); return null; }
  const task = startTask('Ищу ритм в музыке');
  try {
    const r = await api.beats(m.path, c.in, c.out);
    const times = (r.beats as number[]).map(b => c.start + (b - c.in) / c.speed).filter(t => t >= c.start - 1e-3 && t <= clipEnd(c) + 1e-3);
    if (times.length < 4) { toast('info', 'Не получилось найти ритм', { detail: 'Попробуйте трек с чёткими ударами.' }); return null; }
    return { clipId: c.id, bpm: Math.round(r.bpm * c.speed), times, downbeat: r.downbeat };
  } catch (e) {
    toast('error', 'Не удалось найти ритм', { detail: clean(e) });
    return null;
  } finally {
    endTask(task);
  }
}

/** Метки на долях (every = каждая 1, 2 или 4-я, считая от сильной доли) */
export async function beatMarkers(every = 4, source?: string): Promise<number> {
  const b = await findBeats();
  if (!b) return 0;
  const times = b.times.filter((_, i) => ((i - b.downbeat) % every + every) % every === 0);
  commit(`Метки под ритм: ${times.length} (${b.bpm} уд/мин)`, p => {
    p.markers = p.markers.filter(m => !m.label.startsWith('♪'));
    for (const t of times) p.markers.push({ id: uid('k'), time: t, label: '♪', color: '#ff5c8a' });
    p.markers.sort((a, z) => a.time - z.time);
  }, { source });
  return times.length;
}

/** Подрезать клипы основной дорожки, чтобы каждая склейка попадала в долю */
export async function cutToBeats(every = 2, source?: string): Promise<number> {
  const b = await findBeats();
  if (!b) return 0;
  const p0 = get().project!;
  const clips = mainTrack(p0).clips.filter((c): c is MediaClip => c.type === 'media');
  if (!clips.length) { toast('info', 'На основной дорожке нет клипов'); return 0; }
  // склейки идут по сетке долей, начиная с начала ролика
  const grid = b.times;
  let changed = 0;
  commit(`Склейки под ритм (${b.bpm} уд/мин)`, p => {
    const main = mainTrack(p);
    const ids: string[] = [];
    for (const c of main.clips) {
      if (c.type !== 'media') continue;
      layoutMain(main);
      const end = clipEnd(c);
      const [nd] = fitToBeats([clipDuration(c)], grid.map(t => t - c.start), every, b.downbeat, 0);
      if (Math.abs(c.start + nd - end) > 0.01) {
        c.out = c.in + nd * c.speed;
        ids.push(c.id);
        changed++;
      }
    }
    return ids;
  }, { source });
  toast(changed ? 'success' : 'info', changed ? `Подрезано клипов: ${changed}` : 'Клипы уже попадают в ритм', { detail: changed ? 'Каждая склейка теперь на доле. Отменить: Ctrl+Z.' : undefined });
  return changed;
}
