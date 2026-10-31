// Плавная смена скорости по кривой (с 0.9). Обработка идёт в копию файла, как стабилизация:
// исходник не меняется, а «Вернуть оригинал» снимает эффект.
import { api } from '../api';
import type { MediaClip, MediaItem, RampPoint } from '../../shared/types';
import { findClip, mediaById, uid } from '../../shared/timeline';
import { normRamp, rampDuration } from '../../shared/ramp';
import { commit, endTask, get, startTask, toast, updateTask } from './store';
import { loadMediaCache } from './actions';

const clean = (e: unknown) => String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** Откуда брать кадры для кривой: если скорость уже меняли — из того, что было до этого */
export function rampSource(c: MediaClip): { mediaId: string; in: number; out: number } {
  return c.origin?.ramp ? { mediaId: c.origin.ramp.mediaId, in: c.origin.ramp.in, out: c.origin.ramp.out } : { mediaId: c.mediaId, in: c.in, out: c.out };
}

/** Сколько будет длиться клип с такой кривой */
export function rampPreviewLength(c: MediaClip, points: RampPoint[]): number {
  const src = rampSource(c);
  return rampDuration(points, Math.max(0.1, src.out - src.in));
}

export async function applyRamp(clipId: string, points: RampPoint[], source?: string): Promise<void> {
  const p = get().project!;
  const f = findClip(p, clipId);
  if (!f || f.clip.type !== 'media') throw new Error('Нет такого клипа');
  const c = f.clip;
  if (c.cam) throw new Error('У мультикамеры скорость по кривой не меняется. Сначала сделайте её обычными клипами');
  const src = rampSource(c);
  const m = mediaById(p, src.mediaId);
  if (!m || m.kind !== 'video' || m.missing) throw new Error('Скорость по кривой меняется только у видео');
  const pts = normRamp(points);
  const jobId = 'r' + Date.now();
  const task = startTask('Меняю скорость по кривой', () => api.processCancel(jobId));
  const off = api.onProcessProgress((ev: { jobId: string; progress: number }) => { if (ev.jobId === jobId) updateTask(task, { progress: ev.progress }); });
  let path: string;
  try {
    path = await api.processClip(jobId, 'ramp', m.path, src.in, src.out, { ramp: pts, fps: m.fps || p.fps, hasAudio: m.hasAudio });
  } catch (e) {
    const msg = clean(e);
    if (msg !== 'Отменено') toast('error', 'Не удалось изменить скорость', { detail: msg });
    throw new Error(msg);
  } finally {
    off();
    endTask(task);
  }
  const info = await api.probe(path);
  const media: MediaItem = { id: uid('m'), ...info, name: `${m.name.replace(/\.[^.]+$/, '')} — смена скорости` };
  let lostTrack = false;
  commit('Скорость по кривой', pr => {
    if (!pr.media.some(x => x.path === media.path)) pr.media.push(media);
    const mm = pr.media.find(x => x.path === media.path)!;
    const cc = findClip(pr, clipId)!.clip as MediaClip;
    const origin = cc.origin ? structuredClone(cc.origin) : { mediaId: cc.mediaId, in: cc.in, out: cc.out, done: [] as NonNullable<MediaClip['origin']>['done'] };
    origin.ramp = { points: pts, ...src };
    if (!origin.done.includes('ramp')) origin.done.push('ramp');
    cc.mediaId = mm.id; cc.in = 0; cc.out = Math.max(0.1, mm.duration);
    cc.speed = 1; cc.smooth = undefined;
    cc.origin = origin;
    // время в клипе стало другим: старое слежение за объектом больше не совпадает
    if (cc.track) { delete cc.track; lostTrack = true; }
    return [clipId];
  }, { source });
  loadMediaCache(media);
  if (lostTrack) toast('info', 'Слежение за объектом сброшено', { detail: 'После смены скорости обведите объект заново.' });
  if (!source || source === 'user') toast('success', 'Скорость меняется плавно', { detail: 'Нажмите пробел, чтобы посмотреть. «Вернуть оригинал» в разделе «Обработка» снимет эффект.' });
}

/** Убрать только смену скорости (стабилизация и другая обработка остаются) */
export function clearRamp(clipId: string, source?: string) {
  const f = findClip(get().project!, clipId);
  if (!f || f.clip.type !== 'media' || !f.clip.origin?.ramp) return;
  commit('Обычная скорость', p => {
    const c = findClip(p, clipId)!.clip as MediaClip;
    const o = c.origin!;
    const r = o.ramp!;
    c.mediaId = r.mediaId; c.in = r.in; c.out = r.out;
    delete o.ramp;
    o.done = o.done.filter(d => d !== 'ramp');
    if (!o.done.length && c.mediaId === o.mediaId) delete c.origin;
    return [clipId];
  }, { source });
}
