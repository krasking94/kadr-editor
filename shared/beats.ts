// Поиск долей (ударов) в музыке без интернета: огибающая «всплесков» звука, темп по автокорреляции,
// затем сетка долей, которая подстраивается под живые неровности ритма.

export interface BeatResult {
  bpm: number;
  beats: number[]; // секунды от начала отрывка
  downbeat: number; // номер доли (0..3), с которой начинаются такты
}

const HOP = 256;

/** Огибающая всплесков: насколько резко выросла громкость (и отдельно — громкость «щелчков») */
export function onsetEnvelope(x: Float32Array, sr: number): { env: Float32Array; fps: number } {
  const frames = Math.floor(x.length / HOP);
  const env = new Float32Array(frames);
  let prevA = 0, prevB = 0, last = 0;
  for (let f = 0; f < frames; f++) {
    let a = 0, b = 0;
    for (let i = f * HOP; i < (f + 1) * HOP; i++) {
      const v = x[i];
      a += v * v;
      const d = v - last; // разность соседних отсчётов выделяет удары и хэты
      b += d * d;
      last = v;
    }
    const la = Math.log(1e-9 + a / HOP), lb = Math.log(1e-9 + b / HOP);
    env[f] = f ? Math.max(0, la - prevA) + Math.max(0, lb - prevB) : 0;
    prevA = la; prevB = lb;
  }
  // убираем медленный фон: вычитаем среднее за полсекунды
  const fps = sr / HOP;
  const win = Math.max(1, Math.round(fps * 0.25));
  const pre = new Float64Array(frames + 1);
  for (let f = 0; f < frames; f++) pre[f + 1] = pre[f] + env[f];
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const lo = Math.max(0, f - win), hi = Math.min(frames, f + win + 1);
    out[f] = Math.max(0, env[f] - (pre[hi] - pre[lo]) / (hi - lo));
  }
  let max = 0;
  for (const v of out) if (v > max) max = v;
  if (max > 0) for (let f = 0; f < frames; f++) out[f] /= max;
  return { env: out, fps };
}

/** Темп в кадрах огибающей: лучший период повторения в диапазоне 60–190 ударов в минуту */
function bestPeriod(env: Float32Array, fps: number): number {
  const minLag = Math.floor((fps * 60) / 190), maxLag = Math.ceil((fps * 60) / 60);
  const scores: number[] = [];
  let best = minLag, bestScore = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = lag; i < env.length; i++) s += env[i] * env[i - lag];
    s /= env.length - lag;
    // предпочитаем темп около 120: так меньше путаницы «вдвое быстрее / медленнее»
    const bpm = (fps * 60) / lag;
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    scores[lag] = s;
    if (s * w > bestScore) { bestScore = s * w; best = lag; }
  }
  // уточняем период между соседними значениями
  const a = scores[best - 1] ?? scores[best], b = scores[best], c = scores[best + 1] ?? scores[best];
  const den = a - 2 * b + c;
  return den < 0 ? best + 0.5 * (a - c) / den : best;
}

export function detectBeats(x: Float32Array, sr: number): BeatResult {
  const { env, fps } = onsetEnvelope(x, sr);
  if (env.length < fps * 3) return { bpm: 0, beats: [], downbeat: 0 };
  const period = bestPeriod(env, fps);
  // Доли методом динамического программирования (как у Эллиса): каждая доля выбирается так, чтобы
  // попасть в сильный удар и при этом отстоять от предыдущей примерно на период темпа.
  const n = env.length;
  const score = new Float64Array(n), from = new Int32Array(n).fill(-1);
  const alpha = 6;
  const lo = Math.round(period * 0.5), hi = Math.round(period * 2);
  for (let t = 0; t < n; t++) {
    let best = 0, bi = -1;
    for (let k = t - hi; k <= t - lo; k++) {
      if (k < 0) continue;
      const d = Math.log((t - k) / period);
      const v = score[k] - alpha * d * d;
      if (bi < 0 || v > best) { best = v; bi = k; }
    }
    score[t] = env[t] + (bi >= 0 ? Math.max(0, best) : 0);
    from[t] = bi >= 0 && best > 0 ? bi : -1;
  }
  // конец цепочки — лучший кадр среди последнего периода
  let end = n - 1;
  for (let t = Math.max(0, n - Math.round(period)); t < n; t++) if (score[t] > score[end]) end = t;
  const frames: number[] = [];
  for (let t = end; t >= 0; t = from[t]) frames.push(t);
  frames.reverse();
  const beats = frames.map(f => Math.round((f * HOP / sr) * 1000) / 1000);
  // сильная доля такта: из четырёх вариантов выбираем самый «ударный»
  const sums = [0, 0, 0, 0];
  beats.forEach((b, i) => { sums[i % 4] += env[Math.round(b * fps)] || 0; });
  const downbeat = sums.indexOf(Math.max(...sums));
  return { bpm: Math.round((fps * 60 / period) * 10) / 10, beats, downbeat };
}

/**
 * Длины клипов под ритм: каждый клип заканчивается на доле (каждой every-й, считая от сильной).
 * starts — длительности клипов по порядку; возвращает новые длительности (не длиннее исходных).
 */
export function fitToBeats(durations: number[], beats: number[], every = 1, downbeat = 0, offset = 0, minLen = 0.4): number[] {
  const grid = beats.filter((_, i) => every <= 1 || ((i - downbeat) % every + every) % every === 0).map(b => b + offset);
  let t = 0;
  return durations.map(d => {
    const cands = grid.filter(b => b > t + minLen && b <= t + d + 1e-3);
    const nd = cands.length ? cands[cands.length - 1] - t : d;
    t += nd;
    return nd;
  });
}
