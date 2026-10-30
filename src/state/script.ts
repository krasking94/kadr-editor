// Версия 0.3: монтаж через текст, нарезка длинного видео на короткие ролики, несколько форматов за раз.
// Как и остальные действия, их вызывают кнопки, ИИ-помощник и внешний ИИ по MCP.
import { create } from 'zustand';
import { api } from '../api';
import type { ExportOptions, MediaClip, Project, TextClip } from '../../shared/types';
import { mainTrack, makeTextClip, mediaById, projectDuration, uid } from '../../shared/timeline';
import {
  evenShorts, findPauses, mediaNeedingTranscript, parseShorts, pauseCut, rangesForWords, sentences, timelineWords,
  transcriptForAi, wordsIn, type ShortPick, type TWord,
} from '../../shared/transcript';
import { chunkWords, DEFAULT_FILLERS, findFillers } from '../../shared/speech';
import { providerPreset } from '../../shared/providers';
import { askConfirm, endTask, get, patchMediaEverywhere, startTask, toast, updateTask } from './store';
import { addTrack, BLOGGER_STYLE, queueExport } from './actions';
import { cutTimeline, facePaths, HIGHLIGHTS } from './smart';
import { faceDetector } from '../lib/face-track';

const clean = (e: unknown) => String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// ── Расшифровка речи ─────────────────────────────────
let transcribing: Promise<boolean> | null = null;

/** Распознаёт речь файлов основной дорожки, у которых её ещё нет. Возвращает, есть ли теперь текст. */
export function ensureTranscripts(o: { force?: boolean; language?: string; source?: string } = {}): Promise<boolean> {
  if (transcribing) return transcribing;
  transcribing = (async () => {
    const p = get().project!;
    let list = mediaNeedingTranscript(p);
    if (o.force) {
      const ids = new Set(mainTrack(p).clips.map(c => (c.type === 'media' ? c.origin?.mediaId ?? c.mediaId : '')));
      list = p.media.filter(m => ids.has(m.id) && m.hasAudio && !m.missing);
    }
    for (const [i, m] of list.entries()) {
      const jobId = 't' + Date.now() + i;
      const label = list.length > 1 ? `Распознаю речь (${i + 1} из ${list.length})` : 'Распознаю речь';
      const task = startTask(label, () => api.transcribeMediaCancel(jobId));
      const off = api.onTranscribeProgress((ev: { jobId: string; progress: number }) => { if (ev.jobId === jobId) updateTask(task, { progress: ev.progress }); });
      try {
        const words = await api.transcribeMedia(jobId, m.path, m.duration, o.language);
        patchMediaEverywhere(m.id, { transcript: { words, language: o.language || get().settings.ai.speechLanguage || undefined, at: Date.now() } });
      } catch (e) {
        const msg = clean(e);
        if (msg !== 'Отменено') toast('error', 'Не удалось распознать речь', { detail: msg, ttl: 10000 });
        return false;
      } finally {
        off();
        endTask(task);
      }
    }
    return timelineWords(get().project!).length > 0;
  })().finally(() => { transcribing = null; });
  return transcribing;
}

/** Убрать расшифровку у всех файлов (например, чтобы распознать на другом языке) */
export function forgetTranscripts() {
  for (const m of get().project!.media) if (m.transcript) patchMediaEverywhere(m.id, { transcript: undefined });
}

const quote = (words: TWord[], a: number, b: number) => {
  const list = words.slice(Math.min(a, b), Math.max(a, b) + 1).map(w => w.w);
  const text = list.slice(0, 6).join(' ') + (list.length > 6 ? '…' : '');
  return `«${text}»`;
};

/** Вырезать из видео слова с a по b (номера в тексте ролика) */
export function cutWords(a: number, b: number, source?: string): number {
  const words = timelineWords(get().project!);
  if (!words.length) return 0;
  const ranges = rangesForWords(words, a, b);
  return cutTimeline(ranges, `Вырезано ${quote(words, a, b)}`, source);
}

/** Вырезать несколько кусков текста за один шаг (каждый — пара номеров слов) */
export function cutWordSpans(spans: [number, number][], label: string, source?: string): number {
  const words = timelineWords(get().project!);
  return cutTimeline(spans.flatMap(([a, b]) => rangesForWords(words, a, b)), label, source);
}

const normText = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Найти фразу в тексте ролика: номера первого и последнего слова каждого совпадения */
export function findPhrase(words: TWord[], phrase: string): [number, number][] {
  const target = normText(phrase).split(' ').filter(Boolean);
  if (!target.length) return [];
  const nw = words.map(w => normText(w.w));
  const out: [number, number][] = [];
  for (let i = 0; i + target.length <= nw.length; i++) {
    if (target.every((t, j) => nw[i + j] === t)) { out.push([i, i + target.length - 1]); i += target.length - 1; }
  }
  return out;
}

/** Укоротить паузы между словами длиннее min секунд до keep секунд */
export function shortenPauses(min = 0.7, keep = 0.3, source?: string): { count: number; seconds: number } {
  const words = timelineWords(get().project!);
  const cuts = findPauses(words, min).map(p => pauseCut(p, keep)).filter((r): r is { start: number; end: number } => !!r);
  if (!cuts.length) { toast('info', 'Длинных пауз нет'); return { count: 0, seconds: 0 }; }
  const seconds = cutTimeline(cuts, `Укорочены паузы: ${cuts.length}`, source);
  toast('success', `Видео стало короче на ${seconds.toFixed(1)} с`);
  return { count: cuts.length, seconds };
}

/** Слова-паразиты по готовой расшифровке (без повторного распознавания) */
export function fillerWords(words: TWord[]): TWord[] {
  return findFillers(words, DEFAULT_FILLERS);
}

export async function cutFillersFromText(o: { confirm?: boolean; source?: string } = {}): Promise<number> {
  const words = timelineWords(get().project!);
  const found = fillerWords(words);
  if (!found.length) { toast('info', 'Слов-паразитов не нашлось', { detail: 'Речь и так чистая.' }); return 0; }
  if (o.confirm !== false) {
    const v = await askConfirm({
      title: `Нашёл слов-паразитов: ${found.length}`,
      text: 'Вырезать их из видео? Отменить можно через Ctrl+Z.',
      buttons: [{ label: 'Не надо', kind: 'ghost', value: 'no' }, { label: 'Вырезать', kind: 'primary', value: 'yes' }],
    });
    if (v !== 'yes') return 0;
  }
  const seconds = cutWordSpans(found.map(w => [w.i, w.i]), `Убраны слова-паразиты: ${found.length}`, o.source);
  toast('success', `Видео стало короче на ${seconds.toFixed(1)} с`);
  return found.length;
}

// ── Копия проекта в другом формате (вертикаль, квадрат) ──
/**
 * Копия проекта размером W×H: видео основной дорожки заполняет кадр, «камера» следит за лицом.
 * range — только эта часть ролика (для коротких роликов), shortSubs — крупные субтитры по словам.
 */
export async function formatCopy(p0: Project, W: number, H: number, o: {
  range?: { start: number; end: number }; faces?: boolean; shortSubs?: boolean; title?: string;
  signal?: AbortSignal; onProgress?: (k: number) => void;
} = {}): Promise<Project> {
  const p = structuredClone(p0);
  const sameShape = Math.abs(W / H - p.width / p.height) < 0.01;
  p.width = W; p.height = H;
  if (!sameShape) {
    const clips = mainTrack(p).clips.filter((c): c is MediaClip => c.type === 'media' && mediaById(p, c.mediaId)?.kind !== 'audio');
    let paths = new Map<string, { t: number; x: number; y: number }[]>();
    if (o.faces !== false) {
      try {
        await faceDetector();
        paths = await facePaths(p, clips, W, H, { range: o.range, signal: o.signal, onProgress: o.onProgress });
      } catch (e) {
        if (clean(e) === 'Отменено') throw e;
        console.warn('faces', e); // без поиска лиц — кадр по центру
      }
    }
    for (const c of clips) {
      c.fit = 'fill';
      c.transform = { ...c.transform, x: 0.5, y: 0.5, scale: 1, rotation: 0 };
      c.animate = false;
      const path = paths.get(c.id);
      if (path?.length) { c.path = path; c.transform.x = path[0].x; c.transform.y = path[0].y; } else delete c.path;
    }
  }
  if (o.shortSubs || o.title) {
    const range = o.range ?? { start: 0, end: projectDuration(p) };
    if (o.shortSubs) {
      const words = wordsIn(timelineWords(p0), range.start, range.end);
      if (words.length) {
        // старые субтитры заменяем крупными «как у блогеров»
        for (const t of p.tracks) if (t.kind === 'text') t.clips = t.clips.filter(c => !(c.type === 'text' && (c.subtitle || t.name.startsWith('Субтитры'))));
        const t = addTrack(p, 'text');
        t.name = 'Субтитры';
        for (const ch of chunkWords(words, 3)) {
          const c = makeTextClip(ch.text, ch.start, Math.max(0.3, ch.end - ch.start), { ...BLOGGER_STYLE, size: W < H ? 82 : 70, y: W < H ? 0.68 : 0.8 });
          c.subtitle = true; c.animIn = 'none'; c.animOut = 'none';
          c.words = ch.words; c.highlight = HIGHLIGHTS[0];
          t.clips.push(c);
        }
      }
    }
    if (o.title) {
      const t = addTrack(p, 'text');
      t.name = 'Заголовок';
      const c: TextClip = makeTextClip(o.title, range.start, Math.min(4, range.end - range.start), {
        font: 'Unbounded', size: W < H ? 54 : 60, bold: true, y: W < H ? 0.15 : 0.12, background: true, backgroundColor: '#000000',
        backgroundOpacity: 0.7, shadow: false, maxWidth: 0.86,
      });
      c.animIn = 'zoom'; c.animOut = 'fade';
      t.clips.push(c);
    }
  }
  return p;
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Ролик';

async function outFolder(ask: boolean): Promise<string | null> {
  const s = get();
  if (ask) return (await api.folderDialog()) || null;
  return s.settings.exportDir || s.info?.videosDir || '';
}

export const EXTRA_FORMATS = [
  { id: 'vertical', label: 'Вертикаль 9:16', hint: 'Reels, Shorts, TikTok', width: 1080, height: 1920 },
  { id: 'square', label: 'Квадрат 1:1', hint: 'Лента ВК и Instagram', width: 1080, height: 1080 },
  { id: 'wide', label: 'Широкий 16:9', hint: 'YouTube', width: 1920, height: 1080 },
  { id: 'post', label: 'Пост 4:5', hint: 'Instagram', width: 1080, height: 1350 },
];

/** Несколько форматов за раз: каждая копия идёт в очередь сохранения рядом с основным файлом */
export async function queueFormats(ids: string[], base: ExportOptions): Promise<number> {
  const p0 = get().project!;
  let n = 0;
  const ctrl = new AbortController();
  const task = startTask('Готовлю другие форматы', () => ctrl.abort());
  try {
    for (const [i, id] of ids.entries()) {
      const f = EXTRA_FORMATS.find(x => x.id === id);
      if (!f) continue;
      const copy = await formatCopy(p0, f.width, f.height, { signal: ctrl.signal, onProgress: k => updateTask(task, { progress: (i + k) / ids.length }) });
      const outPath = base.outPath.replace(/(\.[^.\\/]+)?$/, ` ${f.width}x${f.height}$1`);
      await queueExport({ ...base, outPath, width: f.width, height: f.height }, copy);
      n++;
    }
  } catch (e) {
    if (clean(e) !== 'Отменено') toast('error', 'Не удалось подготовить форматы', { detail: clean(e) });
  } finally {
    endTask(task);
  }
  return n;
}

// ── Нарезка на короткие ролики ───────────────────────
export interface ShortItem extends ShortPick { id: string; checked: boolean }

interface ShortsState {
  items: ShortItem[];
  busy: '' | 'find' | 'make';
  mode: 'ai' | 'even' | null;
}
export const useShorts = create<ShortsState>(() => ({ items: [], busy: '', mode: null }));

const SHORTS_SYSTEM = (count: number, min: number, max: number) => `You are a top short-form video editor (Reels, YouTube Shorts, TikTok).
You get a transcript of a long video, one phrase per line: [start-end seconds] text.
Pick the ${count} best self-contained moments for vertical shorts. Each must:
- be between ${min} and ${max} seconds long;
- start with a strong hook (question, bold claim, emotion, surprising fact) — no "so", "and", greetings;
- make sense without the rest of the video and end on a complete thought or punchline;
- not overlap with other picks.
Reply with ONLY a JSON array, best first: [{"start": number, "end": number, "title": "catchy title in the language of the video, max 50 chars", "why": "one short sentence in Russian: why this will be watched", "score": 1-10}]`;

export function aiReady(): boolean {
  const s = get();
  const preset = providerPreset(s.settings.ai.provider);
  return !preset.needsKey || !!s.secrets[preset.id];
}

/** Ищет лучшие моменты для коротких роликов. Без подключённой нейросети — делит речь на равные части по фразам. */
export async function findShorts(o: { count?: number; min?: number; max?: number; even?: boolean; source?: string } = {}): Promise<ShortItem[]> {
  const count = Math.max(1, Math.min(20, o.count ?? 5)), min = o.min ?? 20, max = Math.max((o.min ?? 20) + 5, o.max ?? 60);
  useShorts.setState({ busy: 'find' });
  try {
    if (!(await ensureTranscripts({ source: o.source }))) {
      toast('info', 'В ролике не нашлось речи', { detail: 'Нарезка работает по словам: нужна речь и ключ распознавания (Настройки → ИИ).' });
      return [];
    }
    const words = timelineWords(get().project!);
    let picks: ShortPick[] = [];
    let mode: 'ai' | 'even' = 'even';
    if (!o.even && aiReady()) {
      const task = startTask('Нейросеть ищет лучшие моменты');
      try {
        const reply: string = await api.aiComplete(SHORTS_SYSTEM(count, min, max), transcriptForAi(words));
        picks = parseShorts(reply, words, min, max).slice(0, count);
        mode = 'ai';
      } catch (e) {
        toast('warn', 'Нейросеть не ответила — делю на равные части', { detail: clean(e), ttl: 8000 });
      } finally {
        endTask(task);
      }
    } else if (!o.even) {
      toast('info', 'Нейросеть не подключена — делю речь на части по фразам', { detail: 'Чтобы ИИ выбирал самые интересные моменты, подключите его: Настройки → ИИ.', ttl: 8000 });
    }
    if (!picks.length) picks = evenShorts(words, (min + max) / 2, min, max).slice(0, Math.max(count, 30));
    const items = picks.map((k, i) => ({ ...k, id: uid('s'), checked: i < count }));
    useShorts.setState({ items, mode });
    if (!items.length) toast('info', 'Не нашлось подходящих кусков', { detail: `Речь слишком короткая для роликов от ${min} секунд.` });
    return items;
  } finally {
    useShorts.setState({ busy: '' });
  }
}

/** Делает короткие ролики: вертикаль со слежением за лицом, крупные субтитры, заголовок — и ставит в очередь сохранения */
export async function makeShorts(ids?: string[], o: { faces?: boolean; subtitles?: boolean; title?: boolean; ask?: boolean; source?: string; width?: number; height?: number } = {}): Promise<string[]> {
  const items = useShorts.getState().items.filter(i => (ids ? ids.includes(i.id) : i.checked));
  if (!items.length) { toast('info', 'Отметьте хотя бы один момент'); return []; }
  const dir = await outFolder(o.ask !== false && !o.source);
  if (dir === null) return [];
  const p0 = get().project!;
  const W = o.width ?? 1080, H = o.height ?? 1920;
  const sep = dir.includes('\\') ? '\\' : '/';
  const ctrl = new AbortController();
  const task = startTask('Готовлю короткие ролики', () => ctrl.abort());
  useShorts.setState({ busy: 'make' });
  const out: string[] = [];
  try {
    for (const [i, it] of items.entries()) {
      updateTask(task, { label: `Готовлю ролик ${i + 1} из ${items.length}`, progress: i / items.length });
      const copy = await formatCopy(p0, W, H, {
        range: it, faces: o.faces !== false, shortSubs: o.subtitles !== false, title: o.title === false ? undefined : it.title,
        signal: ctrl.signal, onProgress: k => updateTask(task, { progress: (i + k) / items.length }),
      });
      copy.name = it.title;
      const outPath = `${dir}${dir ? sep : ''}${safeName(p0.name)} — ${String(i + 1).padStart(2, '0')} ${safeName(it.title)}.mp4`;
      await queueExport({
        outPath, format: 'mp4', width: W, height: H, fps: p0.fps, quality: 'good', encoder: get().settings.encoder || 'auto',
        rangeStart: it.start, rangeEnd: it.end, loudness: get().settings.loudness || undefined,
      }, copy);
      out.push(outPath);
    }
  } catch (e) {
    if (clean(e) !== 'Отменено') toast('error', 'Не удалось подготовить ролики', { detail: clean(e) });
  } finally {
    endTask(task);
    useShorts.setState({ busy: '' });
  }
  return out;
}

export function toggleShort(id: string, checked?: boolean) {
  useShorts.setState(s => ({ items: s.items.map(i => (i.id === id ? { ...i, checked: checked ?? !i.checked } : i)) }));
}

export function updateShort(id: string, patch: Partial<ShortItem>) {
  useShorts.setState(s => ({ items: s.items.map(i => (i.id === id ? { ...i, ...patch } : i)) }));
}

/** Текст момента (для показа в списке) */
export function shortText(words: TWord[], it: { start: number; end: number }): string {
  return wordsIn(words, it.start, it.end).map(w => w.w).join(' ');
}

/** Отметить моменты на таймлайне метками */
export function shortsToMarkers(source?: string) {
  const items = useShorts.getState().items;
  if (!items.length) return;
  import('./actions').then(A => items.forEach((it, i) => A.addMarker(it.start, `Short ${i + 1}: ${it.title}`, source)));
}

/** Фразы ролика для ИИ (номера слов, время, текст) */
export function transcriptForTool(): { sentences: { from_word: number; to_word: number; start: number; end: number; text: string }[]; words: number } {
  const words = timelineWords(get().project!);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return { words: words.length, sentences: sentences(words, 40).map(s => ({ from_word: s.from, to_word: s.to, start: r2(s.s), end: r2(s.e), text: s.text })) };
}

