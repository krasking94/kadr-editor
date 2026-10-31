// Мультикамера (с 0.9): несколько камер выравниваются по звуку, а при просмотре клавиши 1–4
// переключают, какая камера сейчас в кадре — как у режиссёра прямой трансляции.
import { api } from '../api';
import type { MediaClip, MulticamGroup } from '../../shared/types';
import { clipEnd, findClip, mainTrack, makeMediaClip, mediaById, MIN_CLIP, uid } from '../../shared/timeline';
import { commonRange, groupOf, switchedRange } from '../../shared/multicam';
import { commit, endTask, get, set, startTask, toast } from './store';

export const MAX_ANGLES = 6;

/** Собрать мультикамеру из видео медиатеки. Возвращает id группы. */
export async function createMulticam(mediaIds: string[], o: { audio?: number; name?: string; source?: string } = {}): Promise<string> {
  const p = get().project!;
  const media = mediaIds.map(id => mediaById(p, id)).filter(m => m && m.kind === 'video' && !m.missing);
  if (media.length < 2) { toast('info', 'Нужно хотя бы два видео с разных камер'); throw new Error('Нужно хотя бы два видео'); }
  if (media.length > MAX_ANGLES) { toast('info', `Можно до ${MAX_ANGLES} камер`); throw new Error('Слишком много камер'); }
  const withSound = media.filter(m => m!.hasAudio);
  const task = startTask('Выравниваю камеры по звуку');
  let sync: { offset: number; confidence: number }[];
  try {
    sync = withSound.length === media.length ? await api.syncAudio(media.map(m => m!.path)) : media.map(() => ({ offset: 0, confidence: 0 }));
  } finally {
    endTask(task);
  }
  const weak = sync.slice(1).map((s, i) => ({ s, i: i + 1 })).filter(x => x.s.confidence < 5);
  const g: MulticamGroup = {
    id: uid('mc'), name: o.name || `Мультикамера ${(p.multicam?.length || 0) + 1}`,
    angles: media.map((m, i) => ({ mediaId: m!.id, offset: Math.round(sync[i].offset * 1000) / 1000, label: `Камера ${i + 1}` })),
    audio: o.audio ?? 0,
  };
  const range = commonRange(g, media);
  // если камеры почти не пересекаются, берём всю запись первой камеры
  const start = range.end - range.start > 1 ? range.start : 0;
  const end = range.end - range.start > 1 ? range.end : media[0]!.duration;
  let clipId = '';
  commit('Мультикамера собрана', pr => {
    pr.multicam = [...(pr.multicam || []), g];
    const m0 = media[0]!;
    const c = makeMediaClip(m0, { in: Math.max(0, start), out: Math.min(m0.duration, end), cam: { group: g.id, angle: 0 }, label: g.name });
    mainTrack(pr).clips.push(c);
    clipId = c.id;
    return [c.id];
  }, { source: o.source });
  set({ selection: [clipId], inspectorTab: 'main' });
  if (withSound.length < media.length) toast('warn', 'Не у всех видео есть звук', { detail: 'Камеры поставлены от начала записи. Сдвиг можно поправить в настройках клипа.' });
  else if (weak.length) toast('warn', `Камеру ${weak.map(w => w.i + 1).join(', ')} не удалось точно выровнять по звуку`, { detail: 'Проверьте синхронность и подвиньте сдвиг в настройках клипа. Хлопок в ладоши в начале съёмки помогает.', ttl: 10000 });
  else if (!o.source || o.source === 'user') toast('success', 'Камеры выровнены по звуку', { detail: 'Включите просмотр и нажимайте 1, 2, 3 — программа будет переключать камеры прямо по ходу.', ttl: 8000 });
  return g.id;
}

/** Клип мультикамеры на основной дорожке под временем t */
export function camClipAt(t: number): MediaClip | null {
  const p = get().project;
  if (!p?.multicam?.length) return null;
  const c = mainTrack(p).clips.find(x => x.type === 'media' && x.cam && t >= x.start - 1e-3 && t < clipEnd(x) - 1e-3);
  return (c as MediaClip) || null;
}

/**
 * Переключить камеру с момента t: клип режется по линии времени, и вторая часть идёт с другой камеры.
 * Если t в самом начале клипа — меняется камера всего клипа.
 */
export function switchCamera(angle: number, o: { time?: number; clipId?: string; whole?: boolean; source?: string } = {}): boolean {
  const s = get();
  const p = s.project!;
  const t = o.time ?? s.playhead;
  const c = o.clipId ? (findClip(p, o.clipId)?.clip as MediaClip | undefined) : camClipAt(t);
  if (!c || c.type !== 'media' || !c.cam) { if (!o.source || o.source === 'user') toast('info', 'Под линией времени нет клипа мультикамеры'); return false; }
  const g = groupOf(p, c)!;
  if (!g.angles[angle]) { toast('info', `В этой мультикамере ${g.angles.length} камер(ы)`); return false; }
  if (c.cam.angle === angle) return true;
  const m = mediaById(p, g.angles[angle].mediaId);
  const whole = o.whole || t - c.start < 0.15 || clipEnd(c) - t < MIN_CLIP;
  commit(`Камера ${angle + 1}`, pr => {
    const main = mainTrack(pr);
    const i = main.clips.findIndex(x => x.id === c.id);
    let cur = main.clips[i] as MediaClip;
    if (!whole) {
      // режем по линии времени: первая часть остаётся на старой камере
      const local = t - cur.start;
      const cut = cur.in + local * cur.speed;
      const second: MediaClip = { ...structuredClone(cur), id: uid('c'), in: cut, transition: undefined, fadeIn: 0, audioFadeIn: 0 };
      cur.out = cut; cur.fadeOut = 0; cur.audioFadeOut = 0;
      main.clips.splice(i + 1, 0, second);
      cur = second;
    }
    const r = switchedRange(g, cur, angle, m);
    if (!r) return [cur.id];
    cur.mediaId = g.angles[angle].mediaId;
    cur.in = r.in; cur.out = r.out;
    cur.cam = { group: g.id, angle };
    return [cur.id];
  }, { source: o.source, quiet: true, coalesce: 'cam' + t.toFixed(1) });
  // проверка, что камера в этот момент снимала
  const after = camClipAt(t + 0.01);
  if (after && after.cam?.angle !== angle && (!o.source || o.source === 'user')) toast('info', `Камера ${angle + 1} в этот момент не снимала`);
  return true;
}

/** С какой камеры брать звук: angle или -1 — с той, что в кадре */
export function setCamAudio(groupId: string, angle: number, source?: string) {
  commit(angle < 0 ? 'Звук — с камеры в кадре' : `Звук — с камеры ${angle + 1}`, p => {
    const g = p.multicam?.find(x => x.id === groupId);
    if (g) g.audio = angle;
  }, { source });
}

/** Поправить сдвиг камеры вручную (если по звуку выровнялось неточно) */
export function setCamOffset(groupId: string, angle: number, offset: number) {
  commit('Сдвиг камеры', p => {
    const g = p.multicam?.find(x => x.id === groupId);
    if (!g || !g.angles[angle] || angle === 0) return;
    const delta = offset - g.angles[angle].offset;
    g.angles[angle].offset = offset;
    // клипы этой камеры двигаем вместе со сдвигом, чтобы момент съёмки остался тем же
    for (const c of mainTrack(p).clips) {
      if (c.type !== 'media' || c.cam?.group !== groupId || c.cam.angle !== angle) continue;
      const m = mediaById(p, c.mediaId);
      const len = c.out - c.in;
      c.in = Math.max(0, Math.min((m?.duration ?? c.out) - len, c.in + delta));
      c.out = c.in + len;
    }
  }, { coalesce: `camoff:${groupId}:${angle}` });
}

/** Превратить мультикамеру в обычные клипы (больше нельзя переключать) */
export function flattenMulticam(groupId: string) {
  commit('Мультикамера → обычные клипы', p => {
    for (const t of p.tracks) for (const c of t.clips) if (c.type === 'media' && c.cam?.group === groupId) delete c.cam;
    p.multicam = (p.multicam || []).filter(g => g.id !== groupId);
    if (!p.multicam.length) delete p.multicam;
  });
}
