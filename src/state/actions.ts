// Действия редактора. Их вызывают кнопки, горячие клавиши, ИИ-помощник и внешний ИИ по MCP.
import { api } from '../api';
import type { Clip, ExportOptions, MediaClip, MediaItem, Project, TextClip, TextStyle, Track, TrackKind, TransitionType } from '../../shared/types';
import {
  clipDuration, clipEnd, findClip, FORMAT_PRESETS, layoutProject, makeMediaClip, makeTextClip, mainTrack,
  mediaById, MIN_CLIP, newProject, projectDuration, uid, defaultTextStyle,
} from '../../shared/timeline';
import { renderTextPngs } from '../lib/text-render';
import { loadFonts } from '../lib/fonts';
import { askConfirm, commit, endTask, get, patchMediaCache, set, startTask, toast, updateTask, type QueueItem } from './store';

const deepMerge = <T extends object>(base: T, patch: Partial<T> | undefined): T => ({ ...base, ...(patch || {}) });

// ── Проект ───────────────────────────────────────────
export function openNewProject(width = 1920, height = 1080, name = 'Новый проект') {
  const p = newProject(name, width, height, 30);
  set({ project: p, savedPath: null, dirty: false, past: [], future: [], selection: [], playhead: 0, playing: false, screen: 'editor', zoom: 80 });
  api.setTitle(`${name} — Кадр`);
}

export async function loadProject(project: Project, savedPath: string | null, dirty = false) {
  layoutProject(project);
  set({ project, savedPath, dirty, past: [], future: [], selection: [], playhead: 0, playing: false, screen: 'editor' });
  api.setTitle(`${project.name} — Кадр`);
  fitZoom();
  const missing = project.media.filter(m => m.missing);
  if (missing.length) toast('warn', `Не найдено файлов: ${missing.length}`, { detail: 'Они подсвечены красным в медиатеке. Нажмите на файл, чтобы указать, где он теперь.', ttl: 8000 });
  for (const m of project.media) if (!m.missing) loadMediaCache(m);
}

export async function openProjectFile(path?: string) {
  if (!(await confirmDiscard())) return;
  const file = path || (await api.openProjectDialog());
  if (!file) return;
  try {
    const project = await api.readProject(file);
    await loadProject(project, file);
    toast('success', `Проект «${project.name}» открыт`);
  } catch (e) {
    toast('error', 'Не удалось открыть проект', { detail: String((e as Error).message || e) });
  }
}

export async function saveProject(saveAs = false): Promise<boolean> {
  const s = get();
  if (!s.project) return false;
  let path = s.savedPath;
  if (!path || saveAs) {
    path = await api.saveProjectDialog(s.project.name);
    if (!path) return false;
  }
  try {
    const clean = structuredClone(s.project);
    for (const m of clean.media) delete m.missing;
    await api.writeProject(path, clean);
    set({ savedPath: path, dirty: false });
    api.dropAutosave(s.project.id);
    toast('success', 'Проект сохранён', { detail: path });
    return true;
  } catch (e) {
    toast('error', 'Не удалось сохранить', { detail: String((e as Error).message || e) });
    return false;
  }
}

export async function confirmDiscard(): Promise<boolean> {
  const s = get();
  if (!s.project || !s.dirty) return true;
  const v = await askConfirm({
    title: 'Сохранить изменения?',
    text: `В проекте «${s.project.name}» есть несохранённые изменения.`,
    buttons: [{ label: 'Не сохранять', kind: 'ghost', value: 'discard' }, { label: 'Отмена', kind: 'ghost', value: 'cancel' }, { label: 'Сохранить', kind: 'primary', value: 'save' }],
  });
  if (v === 'cancel') return false;
  if (v === 'save') return saveProject();
  return true;
}

export async function closeProject() {
  if (!(await confirmDiscard())) return;
  set({ project: null, savedPath: null, screen: 'welcome', playing: false, past: [], future: [], selection: [] });
  api.setTitle('Кадр');
}

export function setProjectFormat(width: number, height: number, label?: string) {
  commit(label ? `Формат: ${label}` : `Размер кадра ${width}×${height}`, p => { p.width = width; p.height = height; });
}

// ── Медиафайлы ───────────────────────────────────────
export async function loadMediaCache(m: MediaItem) {
  const cache = get().mediaCache[m.id];
  if (cache && (cache.thumb || cache.waveform || cache.loading)) return;
  patchMediaCache(m.id, { loading: true });
  try {
    const t = await api.thumbs(m.path, m.kind, m.duration);
    patchMediaCache(m.id, { thumb: t.thumb, filmstrip: t.filmstrip });
    if (m.hasAudio) patchMediaCache(m.id, { waveform: await api.waveform(m.path, m.duration) });
  } catch { /* миниатюры не критичны */ }
  patchMediaCache(m.id, { loading: false });
}

export async function importFiles(paths: string[], opts: { toTimeline?: boolean; source?: string; at?: number } = {}): Promise<MediaItem[]> {
  const s = get();
  if (!s.project || !paths.length) return [];
  const task = startTask(`Добавляю файлы (${paths.length})`);
  const added: MediaItem[] = [];
  const errors: string[] = [];
  for (const [i, path] of paths.entries()) {
    updateTask(task, { progress: i / paths.length });
    const existing = get().project!.media.find(m => m.path === path);
    if (existing) { added.push(existing); continue; }
    try {
      const info = await api.probe(path);
      added.push({ id: uid('m'), ...info });
    } catch (e) {
      errors.push(String((e as Error).message || e));
    }
  }
  endTask(task);
  const fresh = added.filter(m => !get().project!.media.some(x => x.id === m.id));
  if (fresh.length || opts.toTimeline) {
    commit(fresh.length === 1 ? `Добавлен файл «${fresh[0].name}»` : `Добавлено файлов: ${fresh.length || added.length}`, p => {
      p.media.push(...fresh);
      if (opts.toTimeline) {
        let at = opts.at ?? 0;
        for (const m of added) {
          if (m.kind === 'audio') {
            const t = p.tracks.find(x => x.kind === 'audio' && !x.locked) || addTrack(p, 'audio');
            const c = makeMediaClip(m, { start: at });
            t.clips.push(c);
          } else {
            mainTrack(p).clips.push(makeMediaClip(m));
          }
          at += m.kind === 'image' ? 5 : m.duration;
        }
      }
    }, { source: opts.source });
    if (get().project!.tracks.some(t => t.clips.length) && opts.toTimeline) fitZoom();
  }
  for (const m of fresh) loadMediaCache(m);
  if (errors.length) toast('error', `Не получилось добавить: ${errors.length}`, { detail: errors.slice(0, 3).join('\n') });
  return added;
}

export async function relinkMedia(id: string) {
  const m = mediaById(get().project!, id);
  if (!m) return;
  const path = await api.relinkDialog(m.name);
  if (!path) return;
  try {
    const info = await api.probe(path);
    commit(`Файл «${m.name}» найден`, p => {
      const mm = mediaById(p, id)!;
      Object.assign(mm, info, { id, missing: false });
    });
    loadMediaCache({ ...m, ...info, id });
  } catch (e) {
    toast('error', 'Этот файл не подходит', { detail: String((e as Error).message) });
  }
}

export function removeMedia(id: string) {
  const p = get().project!;
  const used = p.tracks.some(t => t.clips.some(c => c.type === 'media' && c.mediaId === id));
  commit(used ? 'Файл удалён вместе с клипами' : 'Файл удалён из медиатеки', pr => {
    pr.media = pr.media.filter(m => m.id !== id);
    for (const t of pr.tracks) t.clips = t.clips.filter(c => !(c.type === 'media' && c.mediaId === id));
  });
}

// ── Дорожки ──────────────────────────────────────────
const TRACK_NAMES: Record<TrackKind, string> = { main: 'Основное видео', video: 'Наложение', text: 'Текст', audio: 'Звук' };

export function addTrack(p: Project, kind: TrackKind): Track {
  const count = p.tracks.filter(t => t.kind === kind).length;
  const t: Track = { id: uid('t'), kind, name: TRACK_NAMES[kind] + (count ? ' ' + (count + 1) : ''), muted: false, locked: false, hidden: false, clips: [] };
  // порядок слоёв: главная, наложения, текст, звук
  const order: TrackKind[] = ['main', 'video', 'text', 'audio'];
  let idx = p.tracks.length;
  for (let i = p.tracks.length - 1; i >= 0; i--) {
    if (order.indexOf(p.tracks[i].kind) <= order.indexOf(kind)) { idx = i + 1; break; }
  }
  p.tracks.splice(idx, 0, t);
  return t;
}

export function addTrackAction(kind: TrackKind) {
  commit(`Новая дорожка: ${TRACK_NAMES[kind].toLowerCase()}`, p => { addTrack(p, kind); });
}

export function updateTrack(id: string, patch: Partial<Track>, label: string) {
  commit(label, p => { const t = p.tracks.find(x => x.id === id); if (t) Object.assign(t, patch); });
}

export function deleteTrack(id: string) {
  const t = get().project!.tracks.find(x => x.id === id);
  if (!t || t.kind === 'main') return;
  commit(`Дорожка «${t.name}» удалена`, p => { p.tracks = p.tracks.filter(x => x.id !== id); });
}

function trackFor(p: Project, kind: TrackKind, start: number, dur: number): Track {
  // ищем дорожку нужного вида, где на этом месте свободно, иначе создаём новую
  const free = p.tracks.find(t => t.kind === kind && !t.locked && t.clips.every(c => clipEnd(c) <= start + 1e-3 || c.start >= start + dur - 1e-3));
  return free || addTrack(p, kind);
}

// ── Клипы ────────────────────────────────────────────
export function addToTimeline(mediaId: string, where: 'main' | 'overlay' | 'audio', o: { index?: number; start?: number; in?: number; out?: number; trackId?: string; source?: string; patch?: Partial<MediaClip>; label?: string } = {}): string | null {
  const p0 = get().project!;
  const m = mediaById(p0, mediaId);
  if (!m) throw new Error('Нет такого файла в медиатеке: ' + mediaId);
  if (m.kind === 'audio' && where !== 'audio') where = 'audio';
  if (m.kind !== 'audio' && where === 'audio') where = 'overlay';
  const clip = makeMediaClip(m);
  if (o.in !== undefined) clip.in = Math.max(0, o.in);
  if (o.out !== undefined) clip.out = m.kind === 'image' ? Math.max(MIN_CLIP, o.out) : Math.min(m.duration, Math.max(clip.in + MIN_CLIP, o.out));
  if (where === 'overlay') {
    clip.transform = { x: 0.75, y: 0.27, scale: 0.4, rotation: 0, opacity: 1 };
    clip.transformEnd = { ...clip.transform };
  }
  if (o.patch) Object.assign(clip, o.patch);
  const label = o.label || (where === 'main' ? `«${m.name}» на основной дорожке` : where === 'overlay' ? `«${m.name}» поверх видео` : `«${m.name}» на звуковой дорожке`);
  commit(label, p => {
    if (where === 'main') {
      const t = mainTrack(p);
      const idx = o.index === undefined ? t.clips.length : Math.max(0, Math.min(t.clips.length, Math.round(o.index)));
      t.clips.splice(idx, 0, clip);
    } else {
      clip.start = Math.max(0, o.start ?? get().playhead);
      const kind: TrackKind = where === 'overlay' ? 'video' : 'audio';
      const t = (o.trackId && p.tracks.find(x => x.id === o.trackId && x.kind === kind)) || trackFor(p, kind, clip.start, clipDuration(clip));
      t.clips.push(clip);
      t.clips.sort((a, b) => a.start - b.start);
    }
    return [clip.id];
  }, { source: o.source });
  set({ selection: [clip.id] });
  return clip.id;
}

export function splitAt(time: number, clipId?: string, source?: string): string[] {
  const p0 = get().project!;
  const targets: string[] = [];
  for (const t of p0.tracks) {
    if (t.locked) continue;
    for (const c of t.clips) {
      if (clipId && c.id !== clipId) continue;
      if (time > c.start + MIN_CLIP / 2 && time < clipEnd(c) - MIN_CLIP / 2) targets.push(c.id);
    }
  }
  if (!targets.length) {
    if (source === 'user' || !source) toast('info', 'Под линией времени нет клипа, который можно разрезать');
    return [];
  }
  const created: string[] = [];
  commit(targets.length > 1 ? `Разрезано клипов: ${targets.length}` : 'Клип разрезан', p => {
    for (const id of targets) {
      const f = findClip(p, id)!;
      const c = f.clip;
      const second = structuredClone(c) as Clip;
      second.id = uid(c.type === 'text' ? 'x' : 'c');
      const local = time - c.start;
      if (c.type === 'text') {
        (second as TextClip).start = time;
        (second as TextClip).duration = c.duration - local;
        c.duration = local;
      } else {
        const srcCut = c.in + local * c.speed;
        const s2 = second as MediaClip;
        s2.in = srcCut; s2.start = time; s2.transition = undefined; s2.fadeIn = 0; s2.audioFadeIn = 0;
        c.out = srcCut; c.fadeOut = 0; c.audioFadeOut = 0;
      }
      f.track.clips.splice(f.index + 1, 0, second);
      created.push(second.id);
    }
    return [...targets, ...created];
  }, { source });
  return created;
}

export function deleteClips(ids: string[], source?: string) {
  const p0 = get().project!;
  const real = ids.filter(id => { const f = findClip(p0, id); return f && !f.track.locked; });
  if (!real.length) return;
  commit(real.length > 1 ? `Удалено клипов: ${real.length}` : 'Клип удалён', p => {
    for (const t of p.tracks) t.clips = t.clips.filter(c => !real.includes(c.id));
    const main = mainTrack(p);
    if (main.clips[0]?.type === 'media') main.clips[0].transition = undefined;
  }, { source });
  set(s => ({ selection: s.selection.filter(id => !real.includes(id)) }));
}

export function rippleDelete(ids: string[]) {
  // удалить и сдвинуть следующие клипы на всех незакреплённых дорожках
  const p0 = get().project!;
  const items = ids.map(id => findClip(p0, id)).filter(Boolean) as NonNullable<ReturnType<typeof findClip>>[];
  if (!items.length) return;
  commit('Удалено со сдвигом', p => {
    for (const it of items) {
      const f = findClip(p, it.clip.id);
      if (!f) continue;
      const start = f.clip.start, dur = clipDuration(f.clip);
      f.track.clips.splice(f.index, 1);
      if (f.track.kind !== 'main') for (const c of f.track.clips) if (c.start >= start) c.start = Math.max(0, c.start - dur);
    }
  });
}

export function moveClip(id: string, o: { index?: number; start?: number; trackId?: string }, source?: string) {
  const p0 = get().project!;
  const f = findClip(p0, id);
  if (!f) throw new Error('Нет такого клипа: ' + id);
  commit('Клип перемещён', p => {
    const ff = findClip(p, id)!;
    const target = o.trackId ? p.tracks.find(t => t.id === o.trackId) : ff.track;
    if (!target) return;
    ff.track.clips.splice(ff.index, 1);
    const c = ff.clip;
    if (target.kind === 'main') {
      if (c.type !== 'media') return;
      if (ff.track.kind !== 'main') { c.transform = { x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1 }; c.transformEnd = { ...c.transform }; }
      const idx = Math.max(0, Math.min(target.clips.length, o.index ?? target.clips.length));
      target.clips.splice(idx, 0, c);
      if (target.clips[0] === c) c.transition = undefined;
    } else {
      if (c.type === 'media') c.transition = undefined;
      c.start = Math.max(0, o.start ?? c.start);
      if (ff.track.kind === 'main' && c.type === 'media' && target.kind === 'video') {
        c.transform = { x: 0.75, y: 0.27, scale: 0.4, rotation: 0, opacity: 1 };
        c.transformEnd = { ...c.transform };
      }
      target.clips.push(c);
      target.clips.sort((a, b) => a.start - b.start);
    }
    if (ff.track.kind === 'main' && ff.track.clips[0]?.type === 'media') ff.track.clips[0].transition = undefined;
    return [id];
  }, { source, quiet: true });
}

export function trimClip(id: string, o: { in?: number; out?: number; start?: number; duration?: number }, opts: { source?: string; coalesce?: string } = {}) {
  const p0 = get().project!;
  const f = findClip(p0, id);
  if (!f) throw new Error('Нет такого клипа: ' + id);
  commit('Клип подрезан', p => {
    const c = findClip(p, id)!.clip;
    if (c.type === 'text') {
      if (o.start !== undefined) c.start = Math.max(0, o.start);
      if (o.duration !== undefined) c.duration = Math.max(MIN_CLIP, o.duration);
    } else {
      const m = mediaById(p, c.mediaId)!;
      const maxOut = m.kind === 'image' ? 3600 : m.duration;
      if (o.in !== undefined) c.in = Math.max(0, Math.min(o.in, c.out - MIN_CLIP));
      if (o.out !== undefined) c.out = Math.min(maxOut, Math.max(o.out, c.in + MIN_CLIP));
      if (o.start !== undefined) c.start = Math.max(0, o.start);
    }
    return [id];
  }, { source: opts.source, coalesce: opts.coalesce, quiet: true });
}

export type MediaClipPatch = Partial<Omit<MediaClip, 'transform' | 'transformEnd' | 'color' | 'effects'>> & {
  transform?: Partial<MediaClip['transform']>; transformEnd?: Partial<MediaClip['transformEnd']>;
  color?: Partial<MediaClip['color']>; effects?: Partial<MediaClip['effects']>;
};

export function updateMediaClip(id: string, patch: MediaClipPatch, label: string, opts: { source?: string; coalesce?: string } = {}) {
  const f = findClip(get().project!, id);
  if (!f || f.clip.type !== 'media') throw new Error('Это не видео/звуковой клип: ' + id);
  commit(label, p => {
    const c = findClip(p, id)!.clip as MediaClip;
    const { transform, transformEnd, color, effects, ...rest } = patch;
    Object.assign(c, rest);
    if (transform) c.transform = deepMerge(c.transform, transform);
    if (transformEnd) c.transformEnd = deepMerge(c.transformEnd, transformEnd);
    if (color) c.color = deepMerge(c.color, color);
    if (effects) c.effects = deepMerge(c.effects, effects);
    // при включении анимации сразу задаём мягкое приближение, чтобы эффект был виден
    if (patch.animate && !(f.clip as MediaClip).animate && !transformEnd) c.transformEnd = { ...c.transform, scale: c.transform.scale * 1.15 };
    c.speed = Math.max(0.1, Math.min(8, c.speed));
    c.volume = Math.max(0, Math.min(2, c.volume));
    return [id];
  }, { source: opts.source, coalesce: opts.coalesce ?? 'clip:' + id + ':' + label });
}

export type TextClipPatch = Partial<Omit<TextClip, 'style'>> & { style?: Partial<TextStyle> };

export function updateTextClip(id: string, patch: TextClipPatch, label: string, opts: { source?: string; coalesce?: string } = {}) {
  const f = findClip(get().project!, id);
  if (!f || f.clip.type !== 'text') throw new Error('Это не текстовый клип: ' + id);
  commit(label, p => {
    const c = findClip(p, id)!.clip as TextClip;
    const { style, ...rest } = patch;
    Object.assign(c, rest);
    if (style) c.style = { ...c.style, ...style };
    c.duration = Math.max(MIN_CLIP, c.duration);
    c.start = Math.max(0, c.start);
    return [id];
  }, { source: opts.source, coalesce: opts.coalesce ?? 'text:' + id + ':' + label });
}

export function setTransition(clipId: string, type: TransitionType | 'none', duration = 0.6, source?: string) {
  const p0 = get().project!;
  const main = mainTrack(p0);
  const idx = main.clips.findIndex(c => c.id === clipId);
  if (idx < 0) throw new Error('Переход ставится только между клипами основной дорожки');
  if (idx === 0) throw new Error('У первого клипа нет предыдущего — переход поставить некуда. Используйте плавное появление.');
  commit(type === 'none' ? 'Переход убран' : 'Переход добавлен', p => {
    const c = mainTrack(p).clips[idx] as MediaClip;
    c.transition = type === 'none' ? undefined : { type, duration: Math.max(0.1, Math.min(5, duration)) };
    return [clipId, mainTrack(p).clips[idx - 1].id];
  }, { source });
}

export function addText(text: string, start?: number, duration = 3, style: Partial<TextStyle> = {}, anim: { in?: TextClip['animIn']; out?: TextClip['animOut'] } = {}, source?: string): string {
  const s = get();
  const at = Math.max(0, start ?? s.playhead);
  const c = makeTextClip(text, at, duration, style);
  if (anim.in) c.animIn = anim.in;
  if (anim.out) c.animOut = anim.out;
  commit('Добавлен текст', p => {
    const t = trackFor(p, 'text', at, duration);
    t.clips.push(c);
    t.clips.sort((a, b) => a.start - b.start);
    return [c.id];
  }, { source });
  set({ selection: [c.id] });
  return c.id;
}

export const SUBTITLE_STYLE: Partial<TextStyle> = { size: 52, y: 0.86, bold: true, background: true, backgroundOpacity: 0.55, shadow: false, maxWidth: 0.8 };

// Стиль «как у блогеров»: крупно, по центру нижней трети, жирная обводка, слово подсвечивается
export const BLOGGER_STYLE: Partial<TextStyle> = { font: 'Montserrat', size: 78, y: 0.72, bold: true, uppercase: true, strokeWidth: 7, strokeColor: '#000000', shadow: true, background: false, maxWidth: 0.86 };

export function addSubtitles(items: { start: number; end: number; text: string; words?: TextClip['words'] }[], replace = false, style: Partial<TextStyle> = {}, source?: string, highlight?: string) {
  const clean = items.filter(i => i.text.trim() && i.end > i.start);
  commit(`Субтитры: ${clean.length} строк`, p => {
    let t = p.tracks.find(x => x.kind === 'text' && x.name.startsWith('Субтитры'));
    if (!t) { t = addTrack(p, 'text'); t.name = 'Субтитры'; }
    if (replace) t.clips = [];
    for (const i of clean) {
      const c = makeTextClip(i.text.trim(), i.start, Math.max(0.3, i.end - i.start), { ...SUBTITLE_STYLE, ...style });
      c.subtitle = true; c.animIn = 'none'; c.animOut = 'none';
      if (i.words?.length && highlight) { c.words = i.words; c.highlight = highlight; }
      t.clips.push(c);
    }
    t.clips.sort((a, b) => a.start - b.start);
  }, { source });
}

export function duplicateClips(ids: string[]) {
  const created: string[] = [];
  commit('Клип продублирован', p => {
    for (const id of ids) {
      const f = findClip(p, id);
      if (!f) continue;
      const copy = structuredClone(f.clip);
      copy.id = uid(copy.type === 'text' ? 'x' : 'c');
      if (f.track.kind === 'main') f.track.clips.splice(f.index + 1, 0, copy);
      else { copy.start = clipEnd(f.clip); f.track.clips.push(copy); f.track.clips.sort((a, b) => a.start - b.start); }
      created.push(copy.id);
    }
    return created;
  });
  set({ selection: created });
}

export function copyClips(ids: string[]) {
  const p = get().project!;
  const clips = ids.map(id => findClip(p, id)).filter(Boolean).map(f => ({ clip: structuredClone(f!.clip), kind: f!.track.kind }));
  if (!clips.length) return;
  set({ clipboard: clips });
  toast('info', clips.length > 1 ? `Скопировано клипов: ${clips.length}` : 'Клип скопирован');
}

export function pasteClips() {
  const items = get().clipboard as { clip: Clip; kind: TrackKind }[];
  if (!items.length) { toast('info', 'Буфер пуст: сначала скопируйте клип (Ctrl+C)'); return; }
  const at = get().playhead;
  const created: string[] = [];
  commit('Клип вставлен', p => {
    const base = Math.min(...items.map(i => i.clip.start));
    for (const it of items) {
      const c = structuredClone(it.clip);
      c.id = uid(c.type === 'text' ? 'x' : 'c');
      if (it.kind === 'main') {
        const main = mainTrack(p);
        const idx = main.clips.findIndex(x => x.start + clipDuration(x) / 2 > at);
        main.clips.splice(idx < 0 ? main.clips.length : idx, 0, c);
      } else {
        c.start = at + (it.clip.start - base);
        trackFor(p, it.kind, c.start, clipDuration(c)).clips.push(c);
      }
      created.push(c.id);
    }
    for (const t of p.tracks) if (t.kind !== 'main') t.clips.sort((a, b) => a.start - b.start);
    return created;
  });
  set({ selection: created });
}

export function detachAudio(id: string) {
  const f = findClip(get().project!, id);
  if (!f || f.clip.type !== 'media') return;
  const c = f.clip;
  const m = mediaById(get().project!, c.mediaId);
  if (!m?.hasAudio || m.kind !== 'video') { toast('info', 'В этом клипе нет звука'); return; }
  commit('Звук отделён от видео', p => {
    const cc = findClip(p, id)!.clip as MediaClip;
    const a = makeMediaClip(m, { start: cc.start, in: cc.in, out: cc.out, speed: cc.speed, volume: cc.volume });
    cc.muted = true;
    trackFor(p, 'audio', a.start, clipDuration(a)).clips.push(a);
    return [id, a.id];
  });
}

export async function freezeFrame(id: string) {
  const s = get();
  const f = findClip(s.project!, id);
  if (!f || f.clip.type !== 'media') return;
  const c = f.clip;
  const m = mediaById(s.project!, c.mediaId)!;
  if (m.kind !== 'video') { toast('info', 'Стоп-кадр делается из видео'); return; }
  const local = Math.max(0, Math.min(clipDuration(c), s.playhead - c.start));
  const srcTime = c.in + local * c.speed;
  const path = await api.frameAt(m.path, srcTime);
  const info = await api.probe(path);
  const media: MediaItem = { id: uid('m'), ...info, name: `Стоп-кадр ${m.name}` };
  if (f.track.kind === 'main') {
    // разрезаем по линии времени и вставляем 2 секунды стоп-кадра
    if (local > MIN_CLIP && local < clipDuration(c) - MIN_CLIP) splitAt(s.playhead, id);
    commit('Стоп-кадр на 2 секунды', p => {
      p.media.push(media);
      const main = mainTrack(p);
      const idx = main.clips.findIndex(x => x.id === id);
      const fc = makeMediaClip(media, { out: 2, fit: c.fit, color: structuredClone(c.color), effects: structuredClone(c.effects) });
      main.clips.splice(idx + 1, 0, fc);
      return [fc.id];
    });
  } else {
    commit('Стоп-кадр добавлен', p => {
      p.media.push(media);
      const fc = makeMediaClip(media, { start: s.playhead, out: 2, transform: structuredClone(c.transform), transformEnd: structuredClone(c.transform) });
      trackFor(p, 'video', fc.start, 2).clips.push(fc);
      return [fc.id];
    });
  }
  loadMediaCache(media);
}

export function addMarker(time: number, label = '', source?: string) {
  const n = get().project!.markers.length + 1;
  commit('Метка поставлена', p => {
    p.markers.push({ id: uid('k'), time, label: label || `Метка ${n}`, color: '#ffb547' });
    p.markers.sort((a, b) => a.time - b.time);
  }, { source });
}

export function selectAll() {
  const p = get().project!;
  set({ selection: p.tracks.flatMap(t => t.clips.map(c => c.id)) });
}

// ── Анализ: паузы и сцены ────────────────────────────
export async function removeSilence(o: { db?: number; min?: number; clipId?: string; source?: string } = {}): Promise<number> {
  const s = get();
  const main = mainTrack(s.project!);
  const clips = main.clips.filter((c): c is MediaClip => c.type === 'media' && (!o.clipId || c.id === o.clipId));
  const task = startTask('Ищу паузы в речи');
  const cuts: { id: string; ranges: { start: number; end: number }[] }[] = [];
  try {
    for (const [i, c] of clips.entries()) {
      updateTask(task, { progress: i / clips.length });
      const m = mediaById(s.project!, c.mediaId);
      if (!m?.hasAudio) continue;
      const pauses = await api.silence(m.path, c.in, c.out, o.db ?? -35, o.min ?? 0.6);
      const keep = 0.12; // оставляем немного тишины у краёв, чтобы речь не обрывалась
      const ranges = pauses.map((r: { start: number; end: number }) => ({ start: r.start + keep, end: r.end - keep })).filter((r: { start: number; end: number }) => r.end - r.start > 0.15);
      if (ranges.length) cuts.push({ id: c.id, ranges });
    }
  } finally {
    endTask(task);
  }
  const total = cuts.reduce((a, c) => a + c.ranges.length, 0);
  if (!total) { toast('info', 'Пауз не найдено'); return 0; }
  let removed = 0;
  commit(`Убраны паузы: ${total}`, p => {
    const t = mainTrack(p);
    const touched: string[] = [];
    for (const cut of cuts) {
      const idx = t.clips.findIndex(c => c.id === cut.id);
      if (idx < 0) continue;
      const c = t.clips[idx] as MediaClip;
      const pieces: MediaClip[] = [];
      let cursor = c.in;
      for (const r of cut.ranges) {
        if (r.start - cursor > 0.1) pieces.push({ ...structuredClone(c), id: uid('c'), in: cursor, out: r.start, transition: pieces.length ? undefined : c.transition });
        removed += (r.end - r.start) / c.speed;
        cursor = r.end;
      }
      if (c.out - cursor > 0.1) pieces.push({ ...structuredClone(c), id: uid('c'), in: cursor, out: c.out, transition: pieces.length ? undefined : c.transition });
      t.clips.splice(idx, 1, ...pieces);
      touched.push(...pieces.map(x => x.id));
    }
    return touched;
  }, { source: o.source });
  toast('success', `Видео стало короче на ${removed.toFixed(1)} с`);
  return total;
}

export async function detectScenes(clipId: string, split = true, sensitivity = 0.4, source?: string): Promise<number[]> {
  const s = get();
  const f = findClip(s.project!, clipId);
  if (!f || f.clip.type !== 'media') throw new Error('Нет такого клипа');
  const c = f.clip;
  const m = mediaById(s.project!, c.mediaId)!;
  if (m.kind !== 'video') throw new Error('Сцены ищутся только в видео');
  const task = startTask('Ищу смену сцен');
  let times: number[] = [];
  try {
    times = await api.scenes(m.path, c.in, c.out, Math.max(0.1, Math.min(0.9, 1 - sensitivity * 0.8)));
  } finally {
    endTask(task);
  }
  const timeline = times.map(t => c.start + (t - c.in) / c.speed);
  if (!timeline.length) { toast('info', 'Смен сцен не найдено'); return []; }
  if (split && f.track.kind === 'main') {
    commit(`Разрезано по сценам: ${timeline.length}`, p => {
      const t = mainTrack(p);
      const idx = t.clips.findIndex(x => x.id === clipId);
      const cc = t.clips[idx] as MediaClip;
      const pieces: MediaClip[] = [];
      let cursor = cc.in;
      for (const st of [...times, cc.out]) {
        if (st - cursor < 0.2) continue;
        pieces.push({ ...structuredClone(cc), id: uid('c'), in: cursor, out: st, transition: pieces.length ? undefined : cc.transition });
        cursor = st;
      }
      t.clips.splice(idx, 1, ...pieces);
      return pieces.map(x => x.id);
    }, { source });
  } else {
    commit(`Метки на сменах сцен: ${timeline.length}`, p => {
      for (const [i, t] of timeline.entries()) p.markers.push({ id: uid('k'), time: t, label: `Сцена ${i + 2}`, color: '#5ce1ff' });
      p.markers.sort((a, b) => a.time - b.time);
    }, { source });
  }
  return timeline;
}

// ── Экспорт ──────────────────────────────────────────
async function textRenders(p: Project, scale = 1) {
  await loadFonts();
  const W = Math.round(p.width * scale), H = Math.round(p.height * scale);
  const out: { clipId: string; dataUrl: string; from?: number; to?: number }[] = [];
  for (const t of p.tracks) {
    if (t.hidden || t.kind !== 'text') continue;
    for (const c of t.clips) if (c.type === 'text') for (const r of renderTextPngs(c, W, H)) out.push({ clipId: c.id, ...r });
  }
  return out;
}

function projectForRender(p: Project): Project {
  const copy = structuredClone(p);
  copy.media = copy.media.filter(m => !m.missing);
  for (const t of copy.tracks) t.clips = t.clips.filter(c => c.type !== 'media' || copy.media.some(m => m.id === c.mediaId));
  layoutProject(copy);
  return copy;
}

export async function renderFrame(time: number, width = 960): Promise<string> {
  const p = projectForRender(get().project!);
  const scale = Math.min(1, width / p.width);
  const small = { ...p, width: Math.round(p.width * scale / 2) * 2, height: Math.round(p.height * scale / 2) * 2 };
  return api.renderFrame(small, await textRenders(small), time, width);
}

type ExportResult = { ok: boolean; outPath?: string; error?: string; canceled?: boolean; seconds?: number };

export async function exportVideo(opts: ExportOptions, source?: string, snap?: { project: Project; texts: Awaited<ReturnType<typeof textRenders>> }): Promise<ExportResult> {
  const s = get();
  const p = snap?.project ?? projectForRender(s.project!);
  if (projectDuration(p) <= 0) {
    toast('info', 'Таймлайн пуст: добавьте видео, фото или текст');
    return { ok: false, error: 'Пустой таймлайн' };
  }
  const jobId = 'e' + Date.now();
  const task = startTask('Сохраняю видео', () => api.exportCancel(jobId));
  const off = api.onExportProgress((ev: { jobId: string; progress: number; speed: string }) => {
    if (ev.jobId !== jobId) return;
    updateTask(task, { progress: ev.progress, label: `Сохраняю видео${ev.speed ? ' · ' + ev.speed : ''}` });
    api.taskbarProgress(ev.progress);
  });
  try {
    const res: ExportResult = await api.exportStart(jobId, p, snap?.texts ?? await textRenders(p), opts);
    if (res.ok) toast('success', 'Видео готово!', {
      detail: res.outPath, ttl: 12000,
      action: { label: 'Показать в папке', run: () => api.showItem(res.outPath!) },
    });
    else if (res.canceled) toast('info', 'Сохранение отменено');
    else toast('error', 'Не удалось сохранить видео', { detail: res.error, ttl: 12000 });
    if (source && source !== 'user' && res.ok) toast('ai', 'Видео сохранено по просьбе ИИ', { detail: res.outPath });
    return res;
  } finally {
    off();
    endTask(task);
    api.taskbarProgress(-1);
  }
}

// ── Очередь сохранения: ролик запоминается таким, какой он сейчас, и сохраняется по очереди ──
const queued = new Map<string, { opts: ExportOptions; project: Project; texts: Awaited<ReturnType<typeof textRenders>> }>();
let pumping = false;

export async function queueExport(opts: ExportOptions): Promise<void> {
  const p = projectForRender(get().project!);
  if (projectDuration(p) <= 0) { toast('info', 'Таймлайн пуст: добавьте видео, фото или текст'); return; }
  const id = 'q' + Date.now() + Math.random().toString(36).slice(2, 5);
  queued.set(id, { opts, project: p, texts: await textRenders(p) });
  const name = opts.outPath.split(/[\\/]/).pop() || opts.outPath;
  set(s => ({ exportQueue: [...s.exportQueue, { id, name, outPath: opts.outPath, state: 'wait' }] }));
  toast('success', 'Добавлено в очередь сохранения', { detail: name });
  pumpQueue();
}

function patchQueue(id: string, patch: Partial<QueueItem>) {
  set(s => ({ exportQueue: s.exportQueue.map(q => (q.id === id ? { ...q, ...patch } : q)) }));
}

export function removeFromQueue(id: string) {
  queued.delete(id);
  set(s => ({ exportQueue: s.exportQueue.filter(q => q.id !== id || q.state === 'run') }));
}

export function clearFinishedQueue() {
  set(s => ({ exportQueue: s.exportQueue.filter(q => q.state === 'wait' || q.state === 'run') }));
}

async function pumpQueue() {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const next = get().exportQueue.find(q => q.state === 'wait' && queued.has(q.id));
      if (!next) break;
      const job = queued.get(next.id)!;
      queued.delete(next.id);
      patchQueue(next.id, { state: 'run' });
      const res = await exportVideo(job.opts, undefined, job);
      patchQueue(next.id, { state: res.ok ? 'done' : res.canceled ? 'canceled' : 'error', error: res.error });
    }
    const q = get().exportQueue;
    if (q.length > 1 && q.every(i => i.state !== 'wait' && i.state !== 'run')) toast('success', 'Очередь сохранения закончена', { detail: `Готово: ${q.filter(i => i.state === 'done').length} из ${q.length}` });
  } finally {
    pumping = false;
  }
}

export type Segment = { start: number; end: number; text: string; words?: { s: number; e: number; w: string }[] };

export async function transcribeProject(o: { clipId?: string; addSubs?: boolean; language?: string; source?: string; fillers?: boolean; label?: string } = {}): Promise<Segment[]> {
  const s = get();
  const p = projectForRender(s.project!);
  let range: { start: number; end: number } | undefined;
  if (o.clipId) {
    const f = findClip(p, o.clipId);
    if (f) range = { start: f.clip.start, end: clipEnd(f.clip) };
  }
  const task = startTask(o.label || 'Распознаю речь');
  try {
    const segs: Segment[] = await api.transcribe(p, range, o.language, !!o.fillers);
    if (o.addSubs !== false && segs.length) addSubtitles(segs, !o.clipId, {}, o.source);
    if (!segs.length) toast('info', 'Речь не найдена');
    return segs;
  } catch (e) {
    toast('error', 'Не удалось распознать речь', { detail: String((e as Error).message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') });
    throw e;
  } finally {
    endTask(task);
  }
}

// ── Масштаб таймлайна ────────────────────────────────
export function fitZoom() {
  const p = get().project;
  if (!p) return;
  const dur = Math.max(5, projectDuration(p) * 1.05);
  const el = document.querySelector('.tl-scroll') as HTMLElement | null;
  const width = Math.max(300, (el?.clientWidth ?? window.innerWidth - 700) - 40);
  set({ zoom: Math.max(4, Math.min(400, width / dur)) });
  if (el) el.scrollLeft = 0;
}

export function applyFormatPreset(id: string) {
  const f = FORMAT_PRESETS.find(x => x.id === id);
  if (f) setProjectFormat(f.width, f.height, f.label);
}

export { defaultTextStyle };

// Пример проекта для первого знакомства: три ролика, музыка, заголовок и переходы
export async function openSampleProject() {
  const task = startTask('Готовлю пример');
  let files: string[] = [];
  try {
    files = await api.sampleMedia();
  } catch (e) {
    toast('error', 'Не удалось подготовить пример', { detail: String((e as Error).message || e) });
  } finally {
    endTask(task);
  }
  if (!files.length) return;
  openNewProject(1920, 1080, 'Мой первый ролик');
  const video = files.filter(f => !/\.mp3$/i.test(f));
  const music = files.filter(f => /\.mp3$/i.test(f));
  await importFiles(video, { toTimeline: true });
  const added = await importFiles(music);
  commit('Пример собран', p => {
    const m = mainTrack(p);
    m.clips.forEach((c, i) => { if (i > 0 && c.type === 'media') c.transition = { type: i === 1 ? 'fade' : 'circleopen', duration: 0.8 }; });
    const first = m.clips[0];
    if (first?.type === 'media') { first.animate = true; first.transformEnd = { ...first.transform, scale: 1.2 }; }
    const audioTrack = p.tracks.find(t => t.kind === 'audio')!;
    if (added[0]) audioTrack.clips.push(makeMediaClip(added[0], { start: 0, volume: 0.6, audioFadeIn: 1, audioFadeOut: 2, out: Math.min(added[0].duration, projectDuration(p)) }));
    const textTrack = p.tracks.find(t => t.kind === 'text')!;
    const title = makeTextClip('Привет, это «Кадр»!', 0.4, 3.2, { font: 'Unbounded', size: 90, bold: true, y: 0.45 });
    title.animIn = 'zoom'; title.animOut = 'fade';
    const sub = makeTextClip('Нажмите пробел, чтобы посмотреть', 0.9, 2.7, { size: 42, y: 0.58, color: '#e8e8ff' });
    sub.animIn = 'slide-up';
    textTrack.clips.push(title);
    addTrack(p, 'text').clips.push(sub);
  }, { quiet: true });
  set({ playhead: 0, selection: [] });
  fitZoom();
  toast('success', 'Пример готов', { detail: 'Попробуйте: нажмите пробел, потяните клипы на таймлайне, щёлкните по клипу и поменяйте цвет справа.', ttl: 9000 });
}

export function commitAllTransitions(type: TransitionType | 'none', duration = 0.6) {
  commit(type === 'none' ? 'Все переходы убраны' : 'Переходы на всех стыках', p => {
    const main = mainTrack(p);
    const ids: string[] = [];
    main.clips.forEach((c, i) => {
      if (i === 0 || c.type !== 'media') return;
      c.transition = type === 'none' ? undefined : { type, duration };
      ids.push(c.id);
    });
    return ids;
  });
}
