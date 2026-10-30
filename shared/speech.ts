// Работа с распознанной речью: короткие фразы для субтитров «слово за словом»,
// поиск слов-паразитов и упрощение пути камеры при слежении за лицом.
import type { Word } from './types';

export interface TimedWord { s: number; e: number; w: string }

// Время слов, если сервис распознавания вернул только фразы: делим фразу пропорционально длине слов
export function estimateWords(text: string, start: number, end: number): TimedWord[] {
  const list = text.split(/\s+/).filter(Boolean);
  const total = list.reduce((a, w) => a + w.length + 1, 0) || 1;
  let t = start;
  return list.map(w => {
    const d = ((w.length + 1) / total) * (end - start);
    const r = { s: t, e: t + d, w };
    t += d;
    return r;
  });
}

/** Делит слова на короткие фразы по maxWords слов. Время слов внутри фразы — от её начала. */
export function chunkWords(words: TimedWord[], maxWords = 3, maxChars = 22): { start: number; end: number; text: string; words: Word[] }[] {
  const out: { start: number; end: number; text: string; words: Word[] }[] = [];
  let cur: TimedWord[] = [];
  const flush = () => {
    if (!cur.length) return;
    const start = cur[0].s, end = cur[cur.length - 1].e;
    // точки и запятые на крупных субтитрах лишние; вопрос и восклицание оставляем
    const show = (w: string) => w.replace(/[.,;:]+$/, '') || w;
    out.push({ start, end, text: cur.map(w => show(w.w)).join(' '), words: cur.map(w => ({ s: +(w.s - start).toFixed(3), e: +(w.e - start).toFixed(3), w: show(w.w) })) });
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    const len = cur.reduce((a, x) => a + x.w.length + 1, 0) + w.w.length;
    if (cur.length && (cur.length >= maxWords || len > maxChars || w.s - prev.e > 0.6)) flush();
    cur.push(w);
    if (/[.!?…]$/.test(w.w)) flush();
  }
  flush();
  // фраза держится на экране до начала следующей, если пауза короткая
  for (let i = 0; i < out.length - 1; i++) if (out[i + 1].start - out[i].end < 0.4) out[i].end = out[i + 1].start;
  return out;
}

// «Эээ» и «ммм» сводим к одной букве, чтобы любое количество повторов совпадало
const norm = (w: string) => w.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/(\p{L})\1+/gu, '$1').trim();

export const DEFAULT_FILLERS = ['ээ', 'эм', 'мм', 'ам', 'хм', 'ну вот', 'короче', 'как бы', 'типа', 'это самое', 'в общем', 'так сказать', 'uh', 'um', 'erm'];

/** Находит слова-паразиты. Фразы из нескольких слов («как бы») ищутся подряд. */
export function findFillers<T extends TimedWord>(words: T[], fillers: string[] = DEFAULT_FILLERS): T[] {
  const phrases = fillers.map(f => norm(f).split(/\s+/).filter(Boolean)).filter(f => f.length);
  const nw = words.map(w => norm(w.w));
  const hit = new Set<number>();
  for (let i = 0; i < words.length; i++) {
    for (const ph of phrases) {
      if (ph.every((p, j) => nw[i + j] === p)) for (let j = 0; j < ph.length; j++) hit.add(i + j);
    }
  }
  return words.filter((_, i) => hit.has(i));
}

/** Упрощение ломаной (Рамер — Дуглас — Пекер): оставляет только точки, где движение заметно меняется */
export function simplifyPath<T extends { t: number; x: number; y: number }>(pts: T[], eps = 0.004): T[] {
  if (pts.length <= 2) return pts.slice();
  const dist = (p: T, a: T, b: T) => {
    const k = b.t === a.t ? 0 : (p.t - a.t) / (b.t - a.t);
    return Math.max(Math.abs(p.x - (a.x + (b.x - a.x) * k)), Math.abs(p.y - (a.y + (b.y - a.y) * k)));
  };
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let best = -1, bd = eps;
    for (let i = a + 1; i < b; i++) { const d = dist(pts[i], pts[a], pts[b]); if (d > bd) { bd = d; best = i; } }
    if (best >= 0) { keep[best] = true; stack.push([a, best], [best, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * Сервисы распознавания отдают слова со временем, но без знаков препинания и заглавных букв —
 * они есть только в тексте фраз. Переносим написание из текста фразы на слова.
 */
export function punctuate<T extends { w: string }>(words: T[], text: string): T[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  const key = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]/gu, '');
  let j = 0;
  return words.map(w => {
    const k = key(w.w);
    for (let d = 0; d < 4 && j + d < tokens.length; d++) {
      if (key(tokens[j + d]) === k && k) {
        const t = tokens[j + d];
        j += d + 1;
        return { ...w, w: t };
      }
    }
    return w;
  });
}

// ── Защита от «выдуманного» текста ──────────────────────────────────────────────
// Whisper в тишине или под музыку иногда пишет то, чего никто не говорил:
// «Продолжение следует…», «Субтитры сделал …», «Спасибо за просмотр». Отсекаем такие фразы
// по громкости звука (нет голоса — нет текста) и по оценкам самого сервиса.

export interface GuardSegment {
  start: number;
  end: number;
  text: string;
  noSpeech?: number; // вероятность, что речи нет (no_speech_prob)
  logprob?: number; // средняя уверенность (avg_logprob)
  compression?: number; // насколько текст повторяется (compression_ratio)
}

const PHANTOMS = [
  'продолжение следует', 'субтитры сделал', 'субтитры создавал', 'субтитры подогнал', 'редактор субтитров', 'корректор',
  'спасибо за просмотр', 'спасибо за внимание', 'подписывайтесь на канал', 'ставьте лайки', 'до новых встреч', 'всем пока',
  'thank you for watching', 'thanks for watching', 'subtitles by', 'please subscribe', 'amara org', 'dimatorzok',
];

const plain = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();

/** Громкость звука по кадрам в децибелах (кадр = 1/fps секунды) */
export function levels(x: Float32Array, sr: number, fps = 20): number[] {
  const hop = Math.max(1, Math.round(sr / fps));
  const out: number[] = [];
  for (let i = 0; i + hop <= x.length; i += hop) {
    let s = 0;
    for (let j = i; j < i + hop; j++) s += x[j] * x[j];
    out.push(10 * Math.log10(1e-10 + s / hop));
  }
  return out;
}

/** Доля кадров отрезка, где слышен голос (громче фона) */
export function voicedShare(db: number[], fps: number, start: number, end: number): number {
  if (!db.length) return 1;
  const sorted = [...db].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.15)];
  const peak = sorted[Math.floor(sorted.length * 0.97)];
  const gate = Math.max(-55, floor + 8, peak - 38);
  const a = Math.max(0, Math.floor(start * fps)), b = Math.min(db.length, Math.ceil(end * fps));
  if (b <= a) return 0;
  let n = 0;
  for (let i = a; i < b; i++) if (db[i] > gate) n++;
  return n / (b - a);
}

/** Убирает фразы, которых, скорее всего, не говорили. db — громкость по кадрам (или пусто, если неизвестна) */
export function dropPhantoms<T extends GuardSegment>(segs: T[], db: number[] = [], fps = 20): T[] {
  const out: T[] = [];
  let repeat = 0;
  for (const s of segs) {
    const t = plain(s.text);
    if (!t) continue;
    const voiced = voicedShare(db, fps, s.start, s.end);
    // нет голоса — нет текста
    if (db.length && voiced < 0.08) continue;
    // сервис сам считает, что тут тишина, и сомневается в словах
    if ((s.noSpeech ?? 0) > 0.6 && (s.logprob ?? 0) < -1) continue;
    // зацикливание: один и тот же кусок много раз подряд
    if ((s.compression ?? 0) > 2.4) continue;
    // известные «фантомы» — если вокруг тихо или сервис не уверен
    if (PHANTOMS.some(p => t.includes(p)) && (voiced < 0.35 || (s.noSpeech ?? 0) > 0.3 || (s.logprob ?? 0) < -0.7)) continue;
    const prev = out[out.length - 1];
    repeat = prev && plain(prev.text) === t && t.length > 8 ? repeat + 1 : 0;
    if (repeat >= 2) continue;
    out.push(s);
  }
  return out;
}
