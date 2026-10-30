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
    out.push({ start, end, text: cur.map(w => w.w).join(' '), words: cur.map(w => ({ s: +(w.s - start).toFixed(3), e: +(w.e - start).toFixed(3), w: w.w })) });
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
