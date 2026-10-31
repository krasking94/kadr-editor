// Сохранение длинного ролика по частям. Если в ролике сотни кусков (обычное дело после «убрать паузы»),
// FFmpeg пришлось бы открыть сотни файлов разом — это гигабайты памяти и слишком длинная команда для Windows.
// Поэтому ролик режется на части по склейкам главной дорожки, каждая часть сохраняется отдельно,
// а потом части соединяются без пересжатия видео. Чистые функции: их проверяют тесты.
import type { Clip, MediaClip, MediaItem, Project, TextRender } from './types';
import { clipEnd, layoutProject, mainTrack, projectDuration, transitionDuration } from './timeline';
import { resolveFollows } from './track';

export interface ExportPart {
  start: number; // начало части на таймлайне (секунды)
  end: number;
  first: number; // клипы главной дорожки first..last входят в часть
  last: number;
}

const EPS = 1e-3;
/** Больше стольких входов (в пересчёте на Full HD) — сохраняем по частям: память FFmpeg растёт с каждым файлом */
export const MAX_INPUTS = 30;
/** Сколько входов открывает одна часть (около гигабайта памяти) */
export const PART_INPUTS = 12;

/**
 * Сколько «весит» клип для FFmpeg: видеофайл Full HD — один вход, 4K — четыре (столько же памяти на распаковку),
 * анимированный текст — по картинке на кусочек.
 */
function weight(c: Clip, renders: Map<string, number>, media: Map<string, MediaItem>): number {
  if (c.type === 'text') return c.animIn === 'none' && c.animOut === 'none' && !c.follow ? 0 : (renders.get(c.id) || 1);
  if (c.adjust) return 0;
  const m = media.get(c.mediaId);
  const big = m && m.kind === 'video' ? Math.max(1, (m.width * m.height) / (1920 * 1080)) : 1;
  return big + (c.faces ? 1 : 0) + (c.cam ? big : 0);
}

/** Клип не на главной дорожке можно разрезать в момент t, ничего не испортив */
function cuttable(c: Clip, t: number): boolean {
  if (c.type === 'text') return !c.follow && (c.animIn === 'none' || t - c.start >= (c.animDuration || 0) + EPS);
  return !c.keys?.length && !c.animate && !c.path?.length && !c.faces && !c.follow && !c.cam && !c.group;
}

/**
 * Разбить ролик на части, в каждой из которых не больше maxInputs файлов.
 * Пустой список — части не нужны, ролик сохраняется одним проходом.
 */
export function planParts(projectIn: Project, texts: TextRender[], maxInputs = PART_INPUTS): ExportPart[] {
  const p: Project = JSON.parse(JSON.stringify(projectIn));
  layoutProject(p);
  const main = mainTrack(p).clips;
  if (main.length < 2) return [];
  const total = projectDuration(p);
  const renders = new Map<string, number>();
  for (const r of texts) renders.set(r.clipId, (renders.get(r.clipId) || 0) + 1);
  const media = new Map(p.media.map(m => [m.id, m]));
  const others = p.tracks.filter(t => t.kind !== 'main').flatMap(t => t.clips);
  const own = main.map(c => weight(c, renders, media));

  // склейка перед клипом i годится, если на ней нет перехода и всё, что лежит поверх неё, можно разрезать
  const okCut = main.map((c, i) => {
    if (i === 0) return false;
    if (transitionDuration(main[i - 1] as MediaClip, c as MediaClip) > 0) return false;
    const t = c.start;
    return others.every(o => !(o.start < t - EPS && clipEnd(o) > t + EPS) || cuttable(o, t));
  });
  const load = (a: number, b: number) => {
    const from = main[a].start, to = b + 1 < main.length ? main[b + 1].start : total;
    let w = 0;
    for (let i = a; i <= b; i++) w += own[i];
    for (const o of others) if (o.start < to - EPS && clipEnd(o) > from + EPS) w += weight(o, renders, media);
    return w;
  };

  const cuts: number[] = [];
  let first = 0, lastOk = -1;
  for (let i = 1; i < main.length; i++) {
    if (load(first, i) > maxInputs && lastOk > first) {
      cuts.push(lastOk);
      first = lastOk;
      lastOk = -1;
    }
    if (okCut[i]) lastOk = i;
  }
  // хвост мог оказаться тяжёлым: последняя подходящая склейка внутри него
  if (load(first, main.length - 1) > maxInputs && lastOk > first) cuts.push(lastOk);
  if (!cuts.length) return [];

  const bounds = [0, ...cuts, main.length];
  return bounds.slice(0, -1).map((b, k) => ({
    start: k === 0 ? 0 : main[b].start,
    end: k === bounds.length - 2 ? total : main[bounds[k + 1]].start,
    first: b,
    last: bounds[k + 1] - 1,
  }));
}

/** Отрезать у клипа начало длиной delta (клип начинается раньше части) */
function cutStart(c: Clip, delta: number, texts: TextRender[]): TextRender[] {
  if (c.type === 'text') {
    const old = c.duration;
    c.duration = Math.max(0.01, old - delta);
    c.animIn = 'none';
    return texts.flatMap(r => {
      if (r.clipId !== c.id) return [r];
      if (r.from === undefined && r.to === undefined) return [r];
      const from = (r.from ?? 0) - delta, to = (r.to ?? old) - delta;
      return to > EPS ? [{ ...r, from: Math.max(0, from), to }] : [];
    });
  }
  const m = c as MediaClip;
  m.in += delta * (m.speed || 1);
  m.fadeIn = Math.max(0, m.fadeIn - delta);
  m.audioFadeIn = Math.max(0, m.audioFadeIn - delta);
  return texts;
}

/**
 * Проект только с тем, что попадает в часть, и сдвинутый так, что часть начинается с нуля.
 * Клипы, которые начинаются раньше части (музыка, подписи), обрезаются по её началу.
 */
export function sliceProject(projectIn: Project, textsIn: TextRender[], part: ExportPart): { project: Project; texts: TextRender[] } {
  const p: Project = JSON.parse(JSON.stringify(projectIn));
  layoutProject(p);
  // путь «едет за объектом» считаем по всему ролику: объект может быть в клипе из другой части
  resolveFollows(p);
  for (const t of p.tracks) for (const c of t.clips) if (c.follow) c.follow = { ...c.follow, baked: true };
  let texts = textsIn;
  const S = part.start, E = part.end;
  for (const t of p.tracks) {
    if (t.kind === 'main') {
      t.clips = t.clips.slice(part.first, part.last + 1);
      const f = t.clips[0];
      if (f && f.type === 'media') delete f.transition; // переход из клипа предыдущей части (по построению его нет)
      continue;
    }
    t.clips = t.clips.filter(c => clipEnd(c) > S + EPS && c.start < E - EPS);
    for (const c of t.clips) {
      if (c.start < S - EPS) {
        texts = cutStart(c, S - c.start, texts);
        c.start = S;
      }
      c.start = Math.max(0, c.start - S);
    }
  }
  p.markers = [];
  const keep = new Set(p.tracks.flatMap(t => t.clips.map(c => c.id)));
  texts = texts.filter(r => keep.has(r.clipId) || (r.clipId.startsWith('faces:') && keep.has(r.clipId.slice(6))));
  layoutProject(p);
  return { project: p, texts };
}

/** Кадры, с которых начинаются части (и последний — конец ролика), с учётом выбранного отрезка */
export function partFrames(parts: ExportPart[], fps: number, from: number, to: number): { part: ExportPart; renderFrom: number; frames: number }[] {
  const out: { part: ExportPart; renderFrom: number; frames: number }[] = [];
  const F = (t: number) => Math.round((t - from) * fps);
  for (const part of parts) {
    const a = Math.max(part.start, from), b = Math.min(part.end, to);
    if (b - a < 1 / fps / 2) continue;
    const frames = F(b) - F(a);
    if (frames > 0) out.push({ part, renderFrom: a, frames });
  }
  return out;
}


/** Сколько файлов FFmpeg откроет для проекта целиком (оценка, без построения команды) */
export function inputLoad(project: Project, texts: TextRender[]): number {
  const renders = new Map<string, number>();
  for (const r of texts) renders.set(r.clipId, (renders.get(r.clipId) || 0) + 1);
  const media = new Map(project.media.map(m => [m.id, m]));
  return project.tracks.reduce((a, t) => a + t.clips.reduce((b, c) => b + weight(c, renders, media), 0), 0);
}

/**
 * Для короткого отрезка (кадр, кусочек звука) тяжёлого проекта: проект только из той части, где лежит отрезок.
 * offset — на сколько секунд сдвинуто время. null — отрезок попадает на несколько частей или части не нужны.
 */
export function narrowToRange(project: Project, texts: TextRender[], from: number, to: number, maxInputs = PART_INPUTS): { project: Project; texts: TextRender[]; offset: number } | null {
  const parts = planParts(project, texts, maxInputs);
  const part = parts.find(x => from >= x.start - EPS && to <= x.end + EPS);
  if (!part) return null;
  return { ...sliceProject(project, texts, part), offset: part.start };
}
