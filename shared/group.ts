// Вложенные клипы: несколько клипов основной дорожки вместе с надписями и картинками поверх
// собираются в один клип (как «вложенная последовательность» в Premiere). Его можно двигать,
// резать и красить как одно целое, а «Разобрать» возвращает всё как было.
import type { Clip, ClipGroup, MediaClip, Project, Track } from './types';
import { clipEnd, layoutProject, mainTrack, uid } from './timeline';

export interface GroupPlan {
  from: number; // первый клип основной дорожки (индекс)
  to: number; // последний (включительно)
  start: number; // начало куска на таймлайне
  end: number;
  layers: { trackId: string; ids: string[] }[]; // клипы других дорожек целиком внутри куска
}

/**
 * Что войдёт во вложенный клип: подряд идущие выбранные клипы основной дорожки
 * и всё с дорожек наложения и текста, что целиком лежит в этом куске времени.
 * Звуковые дорожки (музыка) остаются снаружи.
 */
export function planGroup(p0: Project, ids: string[]): GroupPlan | { error: string } {
  const p: Project = structuredClone(p0);
  layoutProject(p);
  const main = mainTrack(p);
  const idx = main.clips.map((c, i) => (ids.includes(c.id) ? i : -1)).filter(i => i >= 0);
  if (!idx.length) return { error: 'Выделите клипы на основной дорожке (Ctrl+щелчок — несколько)' };
  const from = Math.min(...idx), to = Math.max(...idx);
  if (to - from + 1 !== idx.length) return { error: 'Клипы основной дорожки должны идти подряд, без пропусков' };
  const start = main.clips[from].start, end = clipEnd(main.clips[to]);
  const layers: GroupPlan['layers'] = [];
  for (const t of p.tracks) {
    if (t.kind === 'main' || t.kind === 'audio' || t.hidden) continue;
    const inside = t.clips.filter(c => c.start >= start - 1e-3 && clipEnd(c) <= end + 1e-3).map(c => c.id);
    if (inside.length) layers.push({ trackId: t.id, ids: inside });
  }
  if (idx.length === 1 && !layers.length) return { error: 'Нужно хотя бы два клипа или надпись поверх клипа' };
  return { from, to, start, end, layers };
}

/** Отдельный маленький проект только с этим куском — его программа сохраняет в видеофайл */
export function groupProject(p0: Project, plan: GroupPlan): Project {
  const p: Project = structuredClone(p0);
  layoutProject(p);
  const keep = new Set(plan.layers.flatMap(l => l.ids));
  const tracks: Track[] = [];
  for (const t of p.tracks) {
    if (t.kind === 'main') {
      const clips = t.clips.slice(plan.from, plan.to + 1) as MediaClip[];
      if (clips[0]) clips[0] = { ...clips[0], transition: undefined };
      tracks.push({ ...t, clips });
    } else if (t.kind !== 'audio') {
      const clips = t.clips.filter(c => keep.has(c.id)).map(c => ({ ...c, start: c.start - plan.start }) as Clip);
      tracks.push({ ...t, clips });
    }
  }
  return { ...p, id: uid('p'), name: p.name + ' — часть', tracks, markers: [], multicam: p.multicam ? structuredClone(p.multicam) : undefined, media: p.media.filter(m => usedIn(tracks).has(m.id) || camMedia(p).has(m.id)) };
}

const usedIn = (tracks: Track[]) => new Set(tracks.flatMap(t => t.clips.map(c => (c.type === 'media' ? c.mediaId : ''))));
const camMedia = (p: Project) => new Set((p.multicam || []).flatMap(g => g.angles.map(a => a.mediaId)));

/** Заменить кусок одним клипом из готового файла (mediaId, длина dur). Исходные клипы прячутся внутрь. */
export function applyGroup(p: Project, plan: GroupPlan, mediaId: string, dur: number, label: string): MediaClip {
  layoutProject(p);
  const main = mainTrack(p);
  const inner = main.clips.slice(plan.from, plan.to + 1) as MediaClip[];
  const group: ClipGroup = { start: plan.start, main: structuredClone(inner), layers: [] };
  for (const l of plan.layers) {
    const t = p.tracks.find(x => x.id === l.trackId);
    if (!t) continue;
    group.layers.push({ trackId: t.id, kind: t.kind, name: t.name, clips: structuredClone(t.clips.filter(c => l.ids.includes(c.id))) });
    t.clips = t.clips.filter(c => !l.ids.includes(c.id));
  }
  const first = inner[0];
  const clip: MediaClip = {
    type: 'media', id: uid('c'), mediaId, start: plan.start, in: 0, out: Math.max(0.1, dur), speed: 1,
    volume: 1, muted: false, audioFadeIn: 0, audioFadeOut: 0, fadeIn: 0, fadeOut: 0, fit: 'fit',
    transform: { x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1 }, animate: false, transformEnd: { x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1 },
    color: { preset: 'none', brightness: 0, contrast: 1, saturation: 1, gamma: 1, temperature: 0 },
    effects: { blur: 0, vignette: 0, sharpen: 0, grain: 0, flipH: false, flipV: false },
    transition: first?.transition, label, group,
  };
  main.clips.splice(plan.from, inner.length, clip);
  layoutProject(p);
  return clip;
}

/**
 * Разобрать вложенный клип: исходные клипы встают на место, надписи — на свои дорожки
 * (сдвинутые, если вложенный клип передвинули). Возвращает id вернувшихся клипов.
 */
export function ungroup(p: Project, clipId: string): string[] {
  layoutProject(p);
  const main = mainTrack(p);
  const i = main.clips.findIndex(c => c.id === clipId);
  const c = main.clips[i] as MediaClip | undefined;
  if (!c || c.type !== 'media' || !c.group) return [];
  const g = c.group;
  const shift = c.start - g.start;
  const inner = structuredClone(g.main).map(x => ({ ...x, id: uid('c') }));
  if (inner[0]) inner[0].transition = c.transition;
  main.clips.splice(i, 1, ...inner);
  const out = inner.map(x => x.id);
  for (const l of g.layers) {
    let t = p.tracks.find(x => x.id === l.trackId && x.kind === l.kind);
    if (!t) {
      t = { id: uid('t'), kind: l.kind, name: l.name, muted: false, locked: false, hidden: false, clips: [] };
      // новую дорожку кладём над основной, но под звуком
      const firstAudio = p.tracks.findIndex(x => x.kind === 'audio');
      p.tracks.splice(firstAudio < 0 ? p.tracks.length : firstAudio, 0, t);
    }
    for (const x of structuredClone(l.clips)) {
      const nc = { ...x, id: uid(x.type === 'text' ? 'x' : 'c'), start: Math.max(0, x.start + shift) } as Clip;
      t.clips.push(nc);
      out.push(nc.id);
    }
    t.clips.sort((a, b) => a.start - b.start);
  }
  layoutProject(p);
  return out;
}

/** Длина куска, который соберётся во вложенный клип */
export const planDuration = (plan: GroupPlan) => plan.end - plan.start;
