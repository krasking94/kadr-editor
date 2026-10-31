// Мультикамера: несколько камер снимали одно и то же. Программа сама выравнивает их по звуку,
// а дальше при просмотре можно щёлкать «камера 1 / 2 / 3», как режиссёр трансляции.
import type { MediaClip, MediaItem, MulticamGroup, Project } from './types';

export const ENV_RATE = 100; // точек огибающей в секунду (шаг 10 мс)

/** Огибающая громкости: средняя энергия звука за каждые 10 мс */
export function envelope(samples: Float32Array, sampleRate: number, rate = ENV_RATE): Float32Array {
  const hop = Math.max(1, Math.round(sampleRate / rate));
  const n = Math.floor(samples.length / hop);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let e = 0;
    for (let j = i * hop, end = j + hop; j < end; j++) e += samples[j] * samples[j];
    out[i] = Math.sqrt(e / hop);
  }
  return out;
}

/**
 * Огибающую превращаем в «всплески»: насколько громкость выросла по сравнению с предыдущим моментом.
 * Хлопки, удары и начала слов одинаково видны на любом микрофоне, даже если одна камера тише другой.
 */
export function onsets(env: Float32Array): Float32Array {
  const out = new Float32Array(env.length);
  for (let i = 1; i < env.length; i++) out[i] = Math.max(0, Math.log1p(env[i] * 50) - Math.log1p(env[i - 1] * 50));
  // нормируем: среднее 0, разброс 1
  let m = 0;
  for (const v of out) m += v;
  m /= Math.max(1, out.length);
  let d = 0;
  for (const v of out) d += (v - m) * (v - m);
  d = Math.sqrt(d / Math.max(1, out.length)) || 1;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - m) / d;
  return out;
}

// Перебор сдвигов: насколько хорошо совпадают всплески a[i] и b[i + lag]
function scan(A: Float32Array, B: Float32Array, from: number, to: number, minOverlap: number) {
  let best = -Infinity, bestLag = 0;
  const scores: number[] = [];
  for (let lag = from; lag <= to; lag++) {
    let sum = 0, cnt = 0;
    const i0 = Math.max(0, -lag), i1 = Math.min(A.length, B.length - lag);
    for (let i = i0; i < i1; i++) { sum += A[i] * B[i + lag]; cnt++; }
    if (cnt < minOverlap) continue;
    const score = sum / cnt;
    scores.push(score);
    if (score > best) { best = score; bestLag = lag; }
  }
  return { best, bestLag, scores };
}

// Уменьшить частоту в k раз, оставив самый сильный всплеск из каждой группы
function pool(x: Float32Array, k: number): Float32Array {
  const out = new Float32Array(Math.floor(x.length / k));
  for (let i = 0; i < out.length; i++) {
    let m = -Infinity;
    for (let j = 0; j < k; j++) m = Math.max(m, x[i * k + j]);
    out[i] = m;
  }
  return out;
}

/**
 * На сколько секунд звук b сдвинут относительно a: если в a хлопок на 10 с, а в b на 12 с, ответ 2.
 * Сначала грубо перебираем сдвиги до maxLag секунд с шагом 50 мс, потом уточняем до 10 мс.
 * confidence — насколько лучший вариант выделяется среди остальных (больше 5 — надёжно).
 */
export function findOffset(a: Float32Array, b: Float32Array, rate = ENV_RATE, maxLag = 240): { offset: number; confidence: number } {
  const A = onsets(a), B = onsets(b);
  const K = 5;
  const A5 = pool(A, K), B5 = pool(B, K);
  const L5 = Math.min(Math.round((maxLag * rate) / K), Math.max(A5.length, B5.length));
  const coarse = scan(A5, B5, -L5, L5, (rate * 2) / K);
  if (!coarse.scores.length) return { offset: 0, confidence: 0 };
  const mean = coarse.scores.reduce((s, v) => s + v, 0) / coarse.scores.length;
  const sd = Math.sqrt(coarse.scores.reduce((s, v) => s + (v - mean) * (v - mean), 0) / coarse.scores.length) || 1;
  const fine = scan(A, B, coarse.bestLag * K - 2 * K, coarse.bestLag * K + 2 * K, rate * 2);
  const lag = fine.scores.length ? fine.bestLag : coarse.bestLag * K;
  return { offset: lag / rate, confidence: (coarse.best - mean) / sd };
}

export const groupOf = (p: Project, c: MediaClip): MulticamGroup | undefined => (c.cam ? p.multicam?.find(g => g.id === c.cam!.group) : undefined);

/** Время «общих часов» мультикамеры (часы камеры 1) для момента исходника камеры angle */
export const refTime = (g: MulticamGroup, angle: number, t: number) => t - (g.angles[angle]?.offset ?? 0);
export const angleTime = (g: MulticamGroup, angle: number, ref: number) => ref + (g.angles[angle]?.offset ?? 0);

/**
 * Переключить клип на другую камеру: тот же момент съёмки, но с другой камеры.
 * Возвращает новые in/out или null, если вторая камера в это время не снимала.
 */
export function switchedRange(g: MulticamGroup, c: MediaClip, angle: number, media: MediaItem | undefined): { in: number; out: number } | null {
  if (!c.cam || !media) return null;
  const a = angleTime(g, angle, refTime(g, c.cam.angle, c.in));
  const b = angleTime(g, angle, refTime(g, c.cam.angle, c.out));
  if (a < -0.05 || b > media.duration + 0.05) return null;
  return { in: Math.max(0, a), out: Math.min(media.duration, Math.max(a + 0.1, b)) };
}

/** Откуда брать звук клипа мультикамеры: та же минута съёмки, но с камеры, выбранной для звука */
export function camAudioSource(p: Project, c: MediaClip): { media: MediaItem; in: number; out: number } | null {
  const g = groupOf(p, c);
  if (!g || g.audio < 0 || g.audio === c.cam!.angle) return null;
  const m = p.media.find(x => x.id === g.angles[g.audio]?.mediaId);
  if (!m || !m.hasAudio) return null;
  const a = angleTime(g, g.audio, refTime(g, c.cam!.angle, c.in));
  const b = angleTime(g, g.audio, refTime(g, c.cam!.angle, c.out));
  return { media: m, in: Math.max(0, a), out: Math.max(Math.max(0, a) + 0.05, b) };
}

/** Общий отрезок, где снимали все камеры (по часам камеры 1) */
export function commonRange(g: MulticamGroup, media: (MediaItem | undefined)[]): { start: number; end: number } {
  let start = -Infinity, end = Infinity;
  g.angles.forEach((a, i) => {
    const m = media[i];
    if (!m) return;
    start = Math.max(start, -a.offset);
    end = Math.min(end, m.duration - a.offset);
  });
  return { start: isFinite(start) ? start + 0 : 0, end: isFinite(end) ? end + 0 : 0 }; // + 0 убирает «минус ноль»
}
