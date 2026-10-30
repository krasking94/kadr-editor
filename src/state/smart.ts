// Умные функции версии 0.2: обработка клипов в копию, слова-паразиты, субтитры «слово за словом»,
// перевод и файлы субтитров, вертикаль со слежением за лицом, стикеры, громкость.
// Как и остальные действия, их вызывают кнопки, ИИ-помощник и внешний ИИ по MCP.
import { api } from '../api';
import type { MediaClip, MediaItem, PathPoint, Project, TextClip } from '../../shared/types';
import { clipDuration, clipEnd, findClip, mainTrack, makeMediaClip, makeTextClip, mediaById, uid } from '../../shared/timeline';
import { baseLayerSize } from '../../shared/export-graph';
import { parseSrt, toSrt } from '../../shared/srt';
import { chunkWords, estimateWords, findFillers, DEFAULT_FILLERS, type TimedWord } from '../../shared/speech';
import { askConfirm, commit, endTask, get, set, startTask, toast, updateTask } from './store';
import { addSubtitles, addTrack, BLOGGER_STYLE, importFiles, loadMediaCache, setProjectFormat, transcribeProject, type Segment } from './actions';
import { cameraPath, faceDetector, trackFaces } from '../lib/face-track';
import { renderShape, type ShapeKind } from '../lib/stickers';

const clean = (e: unknown) => String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// ── Обработка в копию файла: стабилизация и «задом наперёд» ──
const PROCESS_LABEL = { stabilize: 'Убираю тряску', reverse: 'Переворачиваю видео' } as const;

export async function processClip(clipId: string, kind: 'stabilize' | 'reverse', source?: string): Promise<void> {
  const p = get().project!;
  const f = findClip(p, clipId);
  if (!f || f.clip.type !== 'media') throw new Error('Нет такого клипа');
  const c = f.clip;
  const m = mediaById(p, c.mediaId);
  if (!m || m.kind !== 'video') throw new Error(kind === 'stabilize' ? 'Тряску можно убрать только у видео' : 'Задом наперёд можно пустить только видео');
  const jobId = 'p' + Date.now();
  const task = startTask(PROCESS_LABEL[kind], () => api.processCancel(jobId));
  const off = api.onProcessProgress((ev: { jobId: string; progress: number }) => { if (ev.jobId === jobId) updateTask(task, { progress: ev.progress }); });
  let path: string;
  try {
    path = await api.processClip(jobId, kind, m.path, c.in, c.out);
  } catch (e) {
    const msg = clean(e);
    if (msg !== 'Отменено') toast('error', kind === 'stabilize' ? 'Не удалось убрать тряску' : 'Не удалось перевернуть видео', { detail: msg });
    throw new Error(msg);
  } finally {
    off();
    endTask(task);
  }
  const info = await api.probe(path);
  const suffix = kind === 'stabilize' ? 'без тряски' : 'задом наперёд';
  const media: MediaItem = { id: uid('m'), ...info, name: `${m.name.replace(/\.[^.]+$/, '')} — ${suffix}` };
  commit(kind === 'stabilize' ? 'Тряска убрана' : 'Видео задом наперёд', pr => {
    if (!pr.media.some(x => x.path === media.path)) pr.media.push(media);
    const mm = pr.media.find(x => x.path === media.path)!;
    const cc = findClip(pr, clipId)!.clip as MediaClip;
    const origin = cc.origin ? { ...cc.origin, done: [...cc.origin.done] } : { mediaId: cc.mediaId, in: cc.in, out: cc.out, done: [] as ('stabilize' | 'reverse')[] };
    // второй переворот возвращает прямой ход — просто убираем отметку
    if (kind === 'reverse' && origin.done.includes('reverse')) origin.done = origin.done.filter(d => d !== 'reverse');
    else origin.done.push(kind);
    cc.mediaId = mm.id; cc.in = 0; cc.out = Math.max(0.1, mm.duration);
    cc.origin = origin;
    return [clipId];
  }, { source });
  loadMediaCache(media);
}

export function restoreOriginal(clipId: string, source?: string) {
  const f = findClip(get().project!, clipId);
  if (!f || f.clip.type !== 'media' || !f.clip.origin) return;
  commit('Возвращён исходный клип', p => {
    const c = findClip(p, clipId)!.clip as MediaClip;
    const o = c.origin!;
    c.mediaId = o.mediaId; c.in = o.in; c.out = o.out;
    delete c.origin;
    return [clipId];
  }, { source });
}

// ── Вырезать отрезки времени из основной дорожки ──
/**
 * Вырезает куски по времени таймлайна из основной дорожки (клипы режутся, ролик становится короче)
 * и сдвигает субтитры и тексты, чтобы они остались под своими словами. Возвращает, сколько секунд вырезано.
 */
export function cutTimeline(rangesIn: { start: number; end: number }[], label: string, source?: string): number {
  const ranges = [...rangesIn].filter(r => r.end - r.start > 0.02).sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 0.05) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  if (!merged.length) return 0;
  let removed = 0;
  commit(label, p => {
    const t = mainTrack(p);
    const touched: string[] = [];
    const next: typeof t.clips = [];
    for (const c of t.clips) {
      if (c.type !== 'media') { next.push(c); continue; }
      const cs = c.start, ce = clipEnd(c);
      const cuts = merged.filter(r => r.end > cs && r.start < ce).map(r => ({ a: c.in + (Math.max(r.start, cs) - cs) * c.speed, b: c.in + (Math.min(r.end, ce) - cs) * c.speed }));
      if (!cuts.length) { next.push(c); continue; }
      let cursor = c.in, first = true;
      for (const cut of [...cuts, { a: c.out, b: c.out }]) {
        if (cut.a - cursor > 0.05) {
          const piece = { ...structuredClone(c), id: uid('c'), in: cursor, out: cut.a, transition: first ? c.transition : undefined } as MediaClip;
          next.push(piece);
          touched.push(piece.id);
          first = false;
        }
        removed += Math.max(0, cut.b - cut.a) / c.speed;
        cursor = Math.max(cursor, cut.b);
      }
    }
    t.clips = next;
    // тексты и субтитры: сдвигаем влево, вырезанные слова убираем
    for (const r of [...merged].reverse()) {
      const len = r.end - r.start;
      for (const tr of p.tracks) {
        if (tr.kind !== 'text') continue;
        tr.clips = tr.clips.filter(c => {
          const s = c.start, e = c.start + clipDuration(c);
          if (e <= r.start + 1e-3) return true;
          if (s >= r.end - 1e-3) { c.start = Math.max(0, s - len); return true; }
          if (s >= r.start && e <= r.end) return false;
          if (c.type !== 'text') return true;
          const newStart = s < r.start ? s : r.start;
          const overlap = Math.min(e, r.end) - Math.max(s, r.start);
          c.duration = Math.max(0.2, c.duration - overlap);
          if (c.words) {
            c.words = c.words
              .filter(w => { const ws = s + w.s; return ws < r.start || ws >= r.end; })
              .map(w => {
                const ws = s + w.s, we = s + w.e;
                const shift = ws >= r.end ? len : 0;
                return { ...w, s: Math.max(0, ws - shift - newStart), e: Math.max(0, we - shift - newStart) };
              });
            c.text = c.words.map(w => w.w).join(' ') || c.text;
          }
          c.start = newStart;
          return true;
        });
      }
    }
    return touched;
  }, { source });
  return removed;
}

const allWords = (segs: Segment[]): TimedWord[] => segs.flatMap(s => (s.words?.length ? s.words : estimateWords(s.text, s.start, s.end)));

// ── Слова-паразиты ───────────────────────────────────
export async function removeFillers(o: { fillers?: string[]; confirm?: boolean; source?: string } = {}): Promise<{ count: number; seconds: number; words: string[] }> {
  const segs = await transcribeProject({ addSubs: false, fillers: true, label: 'Ищу слова-паразиты', source: o.source });
  const words = segs.flatMap(s => s.words || []);
  if (!words.length && segs.length) {
    toast('warn', 'Сервис распознавания не сообщил время слов', { detail: 'Слова-паразиты умеют искать OpenAI Whisper и Groq. Выберите их в Настройки → ИИ → Распознавание речи.', ttl: 9000 });
    return { count: 0, seconds: 0, words: [] };
  }
  const found = findFillers(words, o.fillers?.length ? o.fillers : DEFAULT_FILLERS);
  if (!found.length) { toast('info', 'Слов-паразитов не нашлось', { detail: 'Речь и так чистая.' }); return { count: 0, seconds: 0, words: [] }; }
  const counts = new Map<string, number>();
  for (const w of found) { const k = w.w.toLowerCase().replace(/[^\p{L}\s-]/gu, ''); counts.set(k, (counts.get(k) || 0) + 1); }
  const summary = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `«${k}» × ${v}`).join(', ');
  if (o.confirm !== false) {
    const v = await askConfirm({
      title: `Нашёл слов-паразитов: ${found.length}`,
      text: `${summary}. Вырезать их из видео? Субтитры сдвинутся вместе с речью. Отменить можно через Ctrl+Z.`,
      buttons: [{ label: 'Не надо', kind: 'ghost', value: 'no' }, { label: 'Вырезать', kind: 'primary', value: 'yes' }],
    });
    if (v !== 'yes') return { count: 0, seconds: 0, words: [] };
  }
  const seconds = cutTimeline(found.map(w => ({ start: w.s - 0.04, end: w.e + 0.04 })), `Убраны слова-паразиты: ${found.length}`, o.source);
  toast('success', `Видео стало короче на ${seconds.toFixed(1)} с`, { detail: summary });
  return { count: found.length, seconds, words: found.map(w => w.w) };
}

// ── Подсказки для ИИ-режиссёра ──
export const DIRECTOR_PROMPT = 'Посмотри мой ролик как опытный режиссёр монтажа. Оцени начало (цепляет ли первые 3 секунды), темп, затянутые места, звук, субтитры, цвет и концовку. Дай 5–7 конкретных советов с таймкодами, по важности. Потом спроси, какие из них сделать.';
export const CHAPTERS_PROMPT = 'Сделай для YouTube: 1) главы с таймкодами (первая 00:00, каждая не короче 10 секунд) по тому, что говорится в ролике; 2) описание на 3–4 предложения; 3) 10 хэштегов; 4) три варианта цепляющего названия. Если в проекте нет расшифровки речи — сначала распознай речь. Ничего в ролике не меняй.';

// ── Субтитры ─────────────────────────────────────────
export const HIGHLIGHTS = ['#ffd60a', '#3ddc97', '#ff3b5c', '#2bd4c5', '#b18cff'];

export async function makeSubtitles(o: { style?: 'classic' | 'blogger'; words?: number; highlight?: string; language?: string; source?: string } = {}): Promise<number> {
  const segs = await transcribeProject({ addSubs: false, language: o.language, source: o.source, label: 'Делаю субтитры' });
  if (!segs.length) return 0;
  if (o.style !== 'blogger') { addSubtitles(segs, true, {}, o.source); return segs.length; }
  const chunks = chunkWords(allWords(segs), Math.max(1, Math.min(8, o.words ?? 3)));
  addSubtitles(chunks, true, BLOGGER_STYLE, o.source, o.highlight || HIGHLIGHTS[0]);
  return chunks.length;
}

const subtitleClips = (p: Project): TextClip[] =>
  p.tracks.flatMap(t => (t.kind === 'text' ? t.clips.filter((c): c is TextClip => c.type === 'text' && (!!c.subtitle || t.name.startsWith('Субтитры'))) : []))
    .sort((a, b) => a.start - b.start);

export async function translateSubtitles(language: string, source?: string): Promise<number> {
  const clips = subtitleClips(get().project!);
  if (!clips.length) { toast('info', 'Сначала сделайте субтитры'); return 0; }
  const task = startTask(`Перевожу субтитры: ${language}`);
  const result = new Map<string, string>();
  try {
    for (let i = 0; i < clips.length; i += 60) {
      updateTask(task, { progress: i / clips.length });
      const part = clips.slice(i, i + 60);
      const reply: string = await api.aiComplete(
        `You translate video subtitles into ${language}. Keep each line short and natural for subtitles, keep the meaning and tone. Reply with ONLY a JSON array of strings: exactly ${part.length} items, in the same order, no comments.`,
        JSON.stringify(part.map(c => c.text)),
      );
      const json = reply.slice(reply.indexOf('['), reply.lastIndexOf(']') + 1);
      let arr: unknown;
      try { arr = JSON.parse(json); } catch { throw new Error('Нейросеть ответила не списком строк. Попробуйте ещё раз или другую модель.'); }
      if (!Array.isArray(arr) || arr.length !== part.length) throw new Error(`Нейросеть вернула ${Array.isArray(arr) ? arr.length : 0} строк вместо ${part.length}. Попробуйте ещё раз.`);
      part.forEach((c, k) => result.set(c.id, String(arr[k] ?? c.text)));
    }
  } catch (e) {
    toast('error', 'Не удалось перевести', { detail: clean(e), ttl: 9000 });
    throw e;
  } finally {
    endTask(task);
  }
  commit(`Субтитры переведены: ${language}`, p => {
    for (const c of subtitleClips(p)) {
      const t = result.get(c.id);
      if (t === undefined) continue;
      c.text = t;
      // время отдельных слов к переводу не подходит — подсветка слов отключается
      delete c.words; delete c.highlight;
    }
  }, { source });
  toast('success', 'Готово! Вернуть исходный текст: Ctrl+Z');
  return result.size;
}

export async function importSubtitles(path?: string) {
  const file = path || (await api.openSubtitlesDialog());
  if (!file) return 0;
  try {
    const items = parseSrt(await api.readText(file));
    if (!items.length) { toast('warn', 'В файле не нашлось субтитров'); return 0; }
    let replace = false;
    if (subtitleClips(get().project!).length) {
      const v = await askConfirm({ title: 'Субтитры уже есть', text: 'Заменить их субтитрами из файла или добавить к ним?', buttons: [{ label: 'Отмена', kind: 'ghost', value: 'cancel' }, { label: 'Добавить', kind: 'ghost', value: 'add' }, { label: 'Заменить', kind: 'primary', value: 'replace' }] });
      if (v === 'cancel') return 0;
      replace = v === 'replace';
    }
    addSubtitles(items, replace);
    return items.length;
  } catch (e) {
    toast('error', 'Не удалось открыть субтитры', { detail: clean(e) });
    return 0;
  }
}

export async function exportSubtitles(path?: string): Promise<string | null> {
  const p = get().project!;
  const clips = subtitleClips(p);
  if (!clips.length) { toast('info', 'В проекте нет субтитров', { detail: 'Сначала сделайте их: вкладка «Текст» → «Сделать субтитры».' }); return null; }
  const file = path || (await api.saveTextDialog(p.name, 'srt', 'Сохранить субтитры'));
  if (!file) return null;
  await api.writeText(file, toSrt(clips.map(c => ({ start: c.start, end: c.start + c.duration, text: c.text }))));
  toast('success', 'Субтитры сохранены', { detail: file, action: { label: 'Показать', run: () => api.showItem(file) } });
  return file;
}

// ── Голос как в студии для всех клипов с речью ──
export function studioVoiceAll(on = true, source?: string): number {
  const p = get().project!;
  const ids = p.tracks.flatMap(t => t.clips)
    .filter((c): c is MediaClip => c.type === 'media' && !c.duck && !!mediaById(p, c.mediaId)?.hasAudio)
    .map(c => c.id);
  if (!ids.length) { toast('info', 'В ролике нет клипов со звуком'); return 0; }
  commit(on ? `Голос как в студии: ${ids.length} клипов` : 'Обработка голоса выключена', pr => {
    for (const id of ids) {
      const c = findClip(pr, id)!.clip as MediaClip;
      c.voice = on;
      c.denoise = on ? Math.max(c.denoise || 0, 0.5) : 0;
    }
    return ids;
  }, { source });
  return ids.length;
}

// ── Вертикаль 9:16 со слежением за лицом ─────────────
/**
 * Путь «камеры» за лицом для клипов основной дорожки в кадре W×H. range — только часть таймлайна
 * (для коротких роликов незачем искать лица во всём часовом видео).
 */
export async function facePaths(p: Project, clips: MediaClip[], W: number, H: number,
  o: { signal?: AbortSignal; onProgress?: (k: number) => void; range?: { start: number; end: number } } = {}): Promise<Map<string, PathPoint[]>> {
  const out = new Map<string, PathPoint[]>();
  for (const [i, c] of clips.entries()) {
    const m = mediaById(p, c.mediaId);
    if (!m || m.kind !== 'video' || m.missing) continue;
    let from = c.in, to = c.out;
    if (o.range) {
      const a = Math.max(o.range.start, c.start), b = Math.min(o.range.end, clipEnd(c));
      if (b <= a) continue;
      from = c.in + (a - c.start) * c.speed; to = c.in + (b - c.start) * c.speed;
    }
    const samples = await trackFaces(m.path, from, to, {
      step: Math.max(0.2, Math.min(1, (to - from) / 240)), signal: o.signal,
      onProgress: k => o.onProgress?.((i + k) / clips.length),
    });
    if (!samples.some(s => s.found)) continue;
    // центр лица в исходнике → положение слоя, чтобы лицо было посередине кадра
    const base = baseLayerSize(m, 'fill', W, H);
    const kx = base.w / W, ky = base.h / H;
    const maxX = Math.max(0, (kx - 1) / 2), maxY = Math.max(0, (ky - 1) / 2);
    out.set(c.id, cameraPath(samples).map(pt => ({
      t: Math.max(0, (pt.t - c.in) / c.speed),
      x: 0.5 + Math.max(-maxX, Math.min(maxX, (0.5 - pt.x) * kx)),
      y: 0.5 + Math.max(-maxY, Math.min(maxY, (0.5 - pt.y) * ky)),
    })));
  }
  return out;
}

export async function autoReframe(o: { width?: number; height?: number; source?: string } = {}): Promise<{ clips: number; faces: number }> {
  const W = o.width ?? 1080, H = o.height ?? 1920;
  const p0 = get().project!;
  const main = mainTrack(p0);
  const clips = main.clips.filter((c): c is MediaClip => c.type === 'media' && mediaById(p0, c.mediaId)?.kind !== 'audio');
  if (!clips.length) { toast('info', 'На основной дорожке нет видео'); return { clips: 0, faces: 0 }; }
  const ctrl = new AbortController();
  const task = startTask('Ищу лица для вертикали', () => ctrl.abort());
  const paths = new Map<string, PathPoint[]>();
  let faces = 0;
  // без WebGL (редко: старый драйвер или виртуальная машина) лица искать нечем — тогда просто кадр по центру
  let canTrack = true;
  try { await faceDetector(); } catch (e) {
    canTrack = false;
    console.warn('face detector', e);
    toast('warn', 'Поиск лиц недоступен на этом компьютере', { detail: 'Видеокарта не дала программе WebGL. Сделаю вертикальный кадр по центру, положение можно поправить мышью.', ttl: 9000 });
  }
  try {
    if (canTrack) for (const [id, pts] of await facePaths(p0, clips, W, H, { signal: ctrl.signal, onProgress: k => updateTask(task, { progress: k }) })) { paths.set(id, pts); faces++; }
  } catch (e) {
    const msg = clean(e);
    if (msg !== 'Отменено') toast('error', 'Не удалось найти лица', { detail: msg });
    throw new Error(msg);
  } finally {
    endTask(task);
  }
  if (p0.width !== W || p0.height !== H) setProjectFormat(W, H, 'вертикаль 9:16');
  commit(faces ? `Вертикаль: слежу за лицом в ${faces} клипах` : 'Вертикаль: кадр по центру', p => {
    const ids: string[] = [];
    for (const c of mainTrack(p).clips) {
      if (c.type !== 'media' || !clips.some(x => x.id === c.id)) continue;
      c.fit = 'fill';
      c.transform = { ...c.transform, x: 0.5, y: 0.5, scale: 1, rotation: 0 };
      c.animate = false;
      const path = paths.get(c.id);
      if (path?.length) { c.path = path; c.transform.x = path[0].x; c.transform.y = path[0].y; } else delete c.path;
      ids.push(c.id);
    }
    return ids;
  }, { source: o.source });
  if (!faces && canTrack) toast('info', 'Лиц не нашлось — кадр поставлен по центру', { detail: 'Положение можно поправить мышью в окне просмотра.' });
  return { clips: clips.length, faces };
}

export function clearPath(clipId: string) {
  commit('Слежение за лицом выключено', p => {
    const c = findClip(p, clipId)?.clip;
    if (c?.type === 'media') delete c.path;
    return [clipId];
  });
}

// ── Стикеры и фигуры ─────────────────────────────────
export function addEmoji(emoji: string, source?: string): string {
  const at = get().playhead;
  const c = makeTextClip(emoji, at, 3, { size: 190, shadow: false, bold: false, x: 0.78, y: 0.3, font: 'Onest' });
  c.animIn = 'zoom'; c.animOut = 'fade'; c.animDuration = 0.35;
  commit('Стикер добавлен', p => {
    const t = p.tracks.find(x => x.kind === 'text' && !x.locked && !x.name.startsWith('Субтитры') && x.clips.every(k => clipEnd(k) <= at + 1e-3 || k.start >= at + 3 - 1e-3)) || addTrack(p, 'text');
    t.clips.push(c);
    t.clips.sort((a, b) => a.start - b.start);
    return [c.id];
  }, { source });
  set({ selection: [c.id] });
  return c.id;
}

export async function addShape(kind: ShapeKind, color: string, source?: string): Promise<string | null> {
  const img = renderShape(kind, color);
  const path = await api.saveImage(img.dataUrl, `Фигура ${kind} ${color.replace('#', '')}`);
  const [m] = await importFiles([path], { source });
  if (!m) return null;
  const at = get().playhead;
  const p = get().project!;
  const clip = makeMediaClip(m, { start: at, out: 3, fadeIn: 0.2, fadeOut: 0.2 });
  const scale = Math.min(0.45, (p.width * 0.35) / Math.max(1, baseLayerSize(m, 'fit', p.width, p.height).w));
  clip.transform = { x: 0.5, y: 0.5, scale: Math.max(0.1, scale), rotation: 0, opacity: 1 };
  clip.transformEnd = { ...clip.transform };
  commit('Фигура добавлена', pr => {
    const t = pr.tracks.find(x => x.kind === 'video' && !x.locked && x.clips.every(k => clipEnd(k) <= at + 1e-3 || k.start >= at + 3 - 1e-3)) || addTrack(pr, 'video');
    t.clips.push(clip);
    t.clips.sort((a, b) => a.start - b.start);
    return [clip.id];
  }, { source });
  set({ selection: [clip.id] });
  return clip.id;
}

// ── Громкость ролика ─────────────────────────────────
export async function analyzeLoudness(): Promise<{ lufs: number; peak: number; lra: number }> {
  const task = startTask('Измеряю громкость');
  try {
    const copy = structuredClone(get().project!);
    copy.media = copy.media.filter(m => !m.missing);
    for (const t of copy.tracks) t.clips = t.clips.filter(c => c.type !== 'media' || copy.media.some(m => m.id === c.mediaId));
    return await api.loudness(copy);
  } finally {
    endTask(task);
  }
}

export function loudnessVerdict(lufs: number): string {
  if (lufs < -30) return 'очень тихо';
  if (lufs < -18) return 'тише, чем нужно для соцсетей';
  if (lufs <= -12) return 'нормально для YouTube, ВК и Telegram';
  return 'слишком громко, возможны искажения';
}

// ── Послушать звук клипа до и после обработки голоса ──
let player: HTMLAudioElement | null = null;
export function stopListening() { player?.pause(); player = null; }

export async function listenClip(clipId: string, processed: boolean): Promise<void> {
  const s = get();
  const p = structuredClone(s.project!);
  const f = findClip(p, clipId);
  if (!f || f.clip.type !== 'media') return;
  const c = f.clip;
  // в копии проекта звучит только этот клип
  for (const t of p.tracks) for (const k of t.clips) if (k.type === 'media' && k.id !== clipId) k.muted = true;
  for (const t of p.tracks) t.muted = false;
  c.muted = false;
  if (!processed) { c.voice = false; c.denoise = 0; }
  p.media = p.media.filter(m => !m.missing);
  const start = Math.max(c.start, Math.min(s.playhead, clipEnd(c) - 1));
  const end = Math.min(clipEnd(c), start + 8);
  stopListening();
  const task = startTask(processed ? 'Готовлю звук после обработки' : 'Готовлю исходный звук');
  try {
    const { mediaUrl } = await import('../api');
    const path: string = await api.audioSnippet(p, start, end);
    player = new Audio(mediaUrl(path));
    player.play().catch(() => undefined);
  } catch (e) {
    toast('error', 'Не удалось подготовить звук', { detail: clean(e) });
  } finally {
    endTask(task);
  }
}
