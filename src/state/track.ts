// Слежение за объектом (с 0.9): человек обводит предмет рамкой в окне просмотра, программа следит за ним
// по всему клипу, а надпись, стикер или размытие едут за ним.
import type { MediaClip, Project, TextClip } from '../../shared/types';
import { clipDuration, findClip, makeTextClip, mediaById } from '../../shared/timeline';
import { frameToSource, objectAt, trackToBlur, type Box } from '../../shared/track';
import { commit, endTask, get, set, startTask, toast, updateTask } from './store';
import { addTrack } from './actions';
import { trackObject } from '../lib/object-track';

const clean = (e: unknown) => String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** Включить режим «обведите объект рамкой» в окне просмотра */
export function startPick(clipId: string) {
  const f = findClip(get().project!, clipId);
  if (!f || f.clip.type !== 'media') return;
  const c = f.clip;
  const s = get();
  // линия времени должна стоять на клипе — там, где объект хорошо видно
  if (s.playhead < c.start || s.playhead >= c.start + clipDuration(c)) set({ playhead: c.start + Math.min(0.5, clipDuration(c) / 2) });
  set({ trackPick: clipId, playing: false, selection: [clipId] });
  toast('info', 'Обведите объект рамкой прямо в кадре', { detail: 'Зажмите мышь и протяните прямоугольник вокруг предмета или человека. Esc — отмена.', ttl: 7000 });
}

export const cancelPick = () => set({ trackPick: null });

/** Рамка в долях кадра проекта → рамка в долях кадра исходника клипа */
export function frameBoxToSource(p: Project, c: MediaClip, box: Box, time: number): Box | null {
  const m = mediaById(p, c.mediaId);
  if (!m) return null;
  const local = Math.max(0, Math.min(clipDuration(c), time - c.start));
  const a = frameToSource(c, m, p.width, p.height, local, box.x, box.y);
  const b = frameToSource(c, m, p.width, p.height, local, box.x + box.w, box.y + box.h);
  const x = Math.max(0, Math.min(a.x, b.x)), y = Math.max(0, Math.min(a.y, b.y));
  return { x, y, w: Math.min(1 - x, Math.abs(b.x - a.x)), h: Math.min(1 - y, Math.abs(b.y - a.y)) };
}

/** Проследить за объектом в рамке box (доли кадра проекта) с момента time по всему клипу */
export async function trackClip(clipId: string, box: Box, o: { time?: number; source?: string; label?: string } = {}): Promise<{ samples: number; lost: number }> {
  set({ trackPick: null });
  const p = get().project!;
  const f = findClip(p, clipId);
  if (!f || f.clip.type !== 'media') throw new Error('Нет такого клипа');
  const c = f.clip;
  const m = mediaById(p, c.mediaId);
  if (!m || m.kind !== 'video' || m.missing) { toast('info', 'Следить можно только за объектом в видео'); throw new Error('Не видео'); }
  const time = Math.max(c.start, Math.min(c.start + clipDuration(c) - 0.01, o.time ?? get().playhead));
  const src = frameBoxToSource(p, c, box, time);
  if (!src || src.w < 0.01 || src.h < 0.01) { toast('info', 'Рамка слишком маленькая — обведите объект крупнее'); throw new Error('Маленькая рамка'); }
  const at = c.in + (time - c.start) * c.speed;
  const ctrl = new AbortController();
  const task = startTask('Слежу за объектом', () => ctrl.abort());
  try {
    const r = await trackObject(m.path, src, at, c.in, c.out, { signal: ctrl.signal, onProgress: k => updateTask(task, { progress: k }) });
    commit('Слежение за объектом', pr => {
      const cc = findClip(pr, clipId)!.clip as MediaClip;
      cc.track = { samples: r.samples, label: o.label };
      return [clipId];
    }, { source: o.source });
    const share = r.lost / Math.max(1, r.samples.length);
    if (share > 0.3) toast('warn', 'Объект часто терялся', { detail: 'Попробуйте обвести его плотнее или выбрать кадр, где он виден лучше всего.', ttl: 9000 });
    else if (!o.source || o.source === 'user') toast('success', 'Объект найден на всём клипе', { detail: 'Теперь прикрепите к нему надпись или размойте его — кнопки в разделе «Слежение за объектом».', ttl: 8000 });
    return { samples: r.samples.length, lost: r.lost };
  } catch (e) {
    const msg = clean(e);
    if (msg !== 'Отменено') toast('error', 'Не удалось проследить за объектом', { detail: msg });
    throw new Error(msg);
  } finally {
    endTask(task);
  }
}

/** Надпись, которая едет за объектом */
export function addTextOnObject(srcClipId: string, text = 'Смотрите сюда!', source?: string): string {
  const p = get().project!;
  const f = findClip(p, srcClipId);
  if (!f || f.clip.type !== 'media' || !f.clip.track) throw new Error('Сначала проследите за объектом');
  const c = f.clip;
  const t = Math.max(c.start, Math.min(c.start + clipDuration(c) - 0.1, get().playhead));
  const pos = objectAt(p, c, t) || { x: 0.5, y: 0.5 };
  const dur = Math.max(1, c.start + clipDuration(c) - t);
  // надпись чуть выше объекта, чтобы его не закрывать
  const tc: TextClip = makeTextClip(text, t, dur, { x: Math.max(0.1, Math.min(0.9, pos.x)), y: Math.max(0.06, pos.y - 0.12), size: 56, background: true, backgroundColor: '#000000', backgroundOpacity: 0.65, shadow: false });
  tc.follow = { clipId: srcClipId };
  commit('Надпись едет за объектом', pr => {
    const tr = pr.tracks.find(x => x.kind === 'text' && !x.locked && x.clips.every(k => k.start + clipDuration(k) <= t + 1e-3 || k.start >= t + dur - 1e-3)) || addTrack(pr, 'text');
    tr.clips.push(tc);
    tr.clips.sort((a, b) => a.start - b.start);
    return [tc.id];
  }, { source });
  set({ selection: [tc.id], inspectorTab: 'text' });
  return tc.id;
}

/** Прикрепить к объекту уже существующий слой (надпись, стикер, картинку) или открепить (srcClipId = null) */
export function attachToObject(targetId: string, srcClipId: string | null, source?: string) {
  commit(srcClipId ? 'Слой едет за объектом' : 'Слой больше не едет за объектом', p => {
    const f = findClip(p, targetId);
    if (!f) return;
    const c = f.clip;
    if (srcClipId) {
      c.follow = { clipId: srcClipId };
    } else {
      // путь движения хранится только в копии проекта для просмотра и экспорта — в самом клипе убираем лишь ссылку
      delete c.follow;
    }
    return [targetId];
  }, { source });
}

/** Размыть объект на всём клипе (номер машины, логотип, экран телефона) */
export function blurObject(clipId: string, strength = 0.75, source?: string) {
  const f = findClip(get().project!, clipId);
  if (!f || f.clip.type !== 'media' || !f.clip.track) throw new Error('Сначала проследите за объектом');
  const c = f.clip;
  commit('Объект размыт', p => {
    const cc = findClip(p, clipId)!.clip as MediaClip;
    cc.faces = trackToBlur(c.track!, c.in, c.out, cc.faces, strength);
    return [clipId];
  }, { source });
  if (!source || source === 'user') toast('success', 'Объект размыт на всём клипе', { detail: 'Силу размытия меняйте во вкладке «Эффекты».' });
}

/** Забыть слежение: слои, которые ехали за объектом, остаются на месте */
export function clearTrack(clipId: string) {
  commit('Слежение убрано', p => {
    for (const t of p.tracks) for (const c of t.clips) {
      if (c.id === clipId && c.type === 'media') delete c.track;
      if (c.follow?.clipId === clipId) delete c.follow;
    }
  });
}
