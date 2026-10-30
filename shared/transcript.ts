// Монтаж через текст: распознанная речь файлов раскладывается по основной дорожке.
// Слова хранятся у файла (время от начала файла), поэтому текст остаётся верным после любых
// разрезов, перестановок, отмены и повтора — его просто заново «прикладывают» к клипам.
import type { MediaItem, Project, Word } from './types';
import { clipEnd, mainTrack, mediaById } from './timeline';

export interface TWord {
  s: number; // время на таймлайне
  e: number;
  w: string;
  clipId: string;
  i: number; // номер слова в тексте ролика
}

// Слова файла для клипа. У обработанной копии (без тряски) время то же, что у исходника со сдвигом.
function clipWords(p: Project, mediaId: string, origin?: { mediaId: string; in: number; done: string[] }): Word[] | null {
  const m = mediaById(p, mediaId);
  if (m?.transcript) return m.transcript.words;
  if (origin && !origin.done.includes('reverse')) {
    const o = mediaById(p, origin.mediaId);
    if (o?.transcript) return o.transcript.words.map(w => ({ ...w, s: w.s - origin.in, e: w.e - origin.in }));
  }
  return null;
}

/** Все слова, которые звучат на основной дорожке, во времени таймлайна */
export function timelineWords(p: Project): TWord[] {
  const out: TWord[] = [];
  for (const c of mainTrack(p).clips) {
    if (c.type !== 'media') continue;
    const words = clipWords(p, c.mediaId, c.origin);
    if (!words) continue;
    const end = clipEnd(c);
    for (const w of words) {
      // слово относится к клипу, если в клип попала его середина
      const mid = (w.s + w.e) / 2;
      if (mid < c.in || mid >= c.out) continue;
      const s = c.start + (Math.max(w.s, c.in) - c.in) / c.speed;
      const e = Math.min(end, c.start + (Math.min(w.e, c.out) - c.in) / c.speed);
      out.push({ s, e: Math.max(s + 0.02, e), w: w.w, clipId: c.id, i: out.length });
    }
  }
  return out;
}

/** Файлы основной дорожки со звуком, у которых ещё нет расшифровки */
export function mediaNeedingTranscript(p: Project): MediaItem[] {
  const out: MediaItem[] = [];
  for (const c of mainTrack(p).clips) {
    if (c.type !== 'media') continue;
    if (clipWords(p, c.mediaId, c.origin)) continue;
    const id = c.origin && !c.origin.done.includes('reverse') ? c.origin.mediaId : c.mediaId;
    const m = mediaById(p, id);
    if (m && m.hasAudio && !m.missing && !out.includes(m)) out.push(m);
  }
  return out;
}

/** Отрезки времени, которые надо вырезать, чтобы убрать слова с a по b включительно */
export function rangesForWords(words: TWord[], a: number, b: number, pad = 0.06): { start: number; end: number }[] {
  if (a > b) [a, b] = [b, a];
  a = Math.max(0, a); b = Math.min(words.length - 1, b);
  if (b < a || !words.length) return [];
  const prev = words[a - 1], next = words[b + 1];
  const start = Math.max(prev ? prev.e : 0, words[a].s - pad);
  const end = next ? Math.min(next.s, words[b].e + pad) : words[b].e + pad;
  return end > start ? [{ start, end }] : [];
}

export interface Pause { after: number; start: number; end: number }

/** Паузы между словами длиннее min секунд */
export function findPauses(words: TWord[], min = 0.7): Pause[] {
  const out: Pause[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    const gap = words[i + 1].s - words[i].e;
    if (gap >= min) out.push({ after: i, start: words[i].e, end: words[i + 1].s });
  }
  return out;
}

/** Что вырезать, чтобы от паузы осталось keep секунд (поровну у краёв, чтобы речь не обрывалась) */
export function pauseCut(p: { start: number; end: number }, keep = 0.3): { start: number; end: number } | null {
  const len = p.end - p.start;
  if (len <= keep + 0.05) return null;
  return { start: p.start + keep / 2, end: p.end - keep / 2 };
}

const SENTENCE_END = /[.!?…]["»”)]*$/;

export interface Sentence { from: number; to: number; s: number; e: number; text: string }

/** Делит текст на фразы: по знакам препинания, длинным паузам и не длиннее maxWords слов */
export function sentences(words: TWord[], maxWords = 30, gap = 1.0): Sentence[] {
  const out: Sentence[] = [];
  let from = 0;
  const flush = (to: number) => {
    if (to < from) return;
    const list = words.slice(from, to + 1);
    out.push({ from, to, s: list[0].s, e: list[list.length - 1].e, text: list.map(w => w.w).join(' ') });
    from = to + 1;
  };
  for (let i = 0; i < words.length; i++) {
    const next = words[i + 1];
    if (!next || SENTENCE_END.test(words[i].w) || next.s - words[i].e > gap || i - from + 1 >= maxWords) flush(i);
  }
  return out;
}

/** Абзацы для показа текста: фразы склеиваются, пока абзац не длиннее ~maxWords слов и нет большой паузы */
export function paragraphs(words: TWord[], maxWords = 45): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (const s of sentences(words)) {
    const last = out[out.length - 1];
    const bigGap = last && s.s - words[last.to].e > 1.6;
    if (last && !bigGap && last.to - last.from + 1 + (s.to - s.from + 1) <= maxWords) last.to = s.to;
    else out.push({ from: s.from, to: s.to });
  }
  return out;
}

const fmt = (t: number) => t.toFixed(1);

/** Текст ролика для нейросети: по строке на фразу с временем начала и конца */
export function transcriptForAi(words: TWord[], maxChars = 120_000): string {
  const lines = sentences(words, 40).map(s => `[${fmt(s.s)}-${fmt(s.e)}] ${s.text}`);
  let out = '';
  for (const l of lines) {
    if (out.length + l.length > maxChars) break;
    out += l + '\n';
  }
  return out;
}

// ── Нарезка на короткие ролики ──
export interface ShortPick { start: number; end: number; title: string; why?: string; score?: number }

/** Подгоняет границы момента к началу и концу фраз и к нужной длине */
export function snapShort(words: TWord[], pick: { start: number; end: number }, min = 15, max = 60): { start: number; end: number } | null {
  const ss = sentences(words, 40);
  if (!ss.length) return null;
  // начало — фраза, в которую попало start (или ближайшая следующая)
  let a = ss.findIndex(s => s.e > pick.start + 0.2);
  if (a < 0) return null;
  if (ss[a].s < pick.start - 3 && a + 1 < ss.length && ss[a + 1].s - pick.start < 1.5) a++;
  // конец — последняя фраза, которая начинается раньше end
  let b = a;
  while (b + 1 < ss.length && ss[b + 1].s < pick.end - 0.3) b++;
  // длиннее нужного — убираем фразы с конца, короче — добавляем
  while (b > a && ss[b].e - ss[a].s > max) b--;
  while (b + 1 < ss.length && ss[b].e - ss[a].s < min && ss[b + 1].e - ss[a].s <= max) b++;
  const start = Math.max(0, ss[a].s - 0.15), end = ss[b].e + 0.25;
  if (end - start < Math.min(min, 5)) return null;
  return { start, end: end - start > max ? start + max : end };
}

/** Читает ответ нейросети со списком моментов (JSON-массив) и выравнивает их по фразам */
export function parseShorts(reply: string, words: TWord[], min = 15, max = 60): ShortPick[] {
  const json = reply.slice(reply.indexOf('['), reply.lastIndexOf(']') + 1);
  let arr: unknown;
  try { arr = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out: ShortPick[] = [];
  for (const x of arr as Record<string, unknown>[]) {
    const start = Number(x?.start), end = Number(x?.end);
    if (!isFinite(start) || !isFinite(end) || end <= start) continue;
    const r = snapShort(words, { start, end }, min, max);
    if (!r) continue;
    // пересечения с уже выбранными моментами не нужны
    if (out.some(o => Math.min(o.end, r.end) - Math.max(o.start, r.start) > 0.3 * (r.end - r.start))) continue;
    out.push({ ...r, title: String(x.title || '').slice(0, 80) || 'Момент', why: x.why ? String(x.why).slice(0, 300) : undefined, score: isFinite(Number(x.score)) ? Number(x.score) : undefined });
  }
  return out;
}

/** Без нейросети: режет речь на части нужной длины по границам фраз */
export function evenShorts(words: TWord[], target = 45, min = 15, max = 60): ShortPick[] {
  const out: ShortPick[] = [];
  const ss = sentences(words, 40);
  let a = 0;
  while (a < ss.length) {
    let b = a;
    while (b + 1 < ss.length && ss[b + 1].e - ss[a].s <= Math.min(max, target * 1.25) && ss[b].e - ss[a].s < target) b++;
    const start = Math.max(0, ss[a].s - 0.15), end = Math.min(ss[b].e + 0.25, start + max);
    if (end - start >= min) out.push({ start, end, title: ss[a].text.split(/\s+/).slice(0, 7).join(' ').replace(/[.,!?…:;]+$/, '') });
    a = b + 1;
  }
  return out;
}

/** Слова в отрезке времени (для субтитров короткого ролика) */
export function wordsIn(words: TWord[], start: number, end: number): TWord[] {
  return words.filter(w => w.s >= start - 0.05 && w.e <= end + 0.1);
}
