// Плавная смена скорости по кривой (speed ramp): клип разгоняется и тормозит без рывков.
// Кривая задаётся точками по исходнику, а сама обработка делается в копию файла (как стабилизация),
// поэтому дальше клип ведёт себя как обычный: режется, двигается и сохраняется без особых правил.
import type { RampPoint } from './types';

export const RAMP_MIN = 0.1;
export const RAMP_MAX = 8;

export const RAMP_PRESETS: { id: string; label: string; tip: string; points: RampPoint[] }[] = [
  { id: 'moment', label: 'Замедлить момент', tip: 'Обычная скорость, в середине — сильное замедление, потом снова обычная. Как в спорте и экшн-роликах',
    points: [{ u: 0, s: 1 }, { u: 0.35, s: 1 }, { u: 0.48, s: 0.25 }, { u: 0.62, s: 0.25 }, { u: 0.75, s: 1 }, { u: 1, s: 1 }] },
  { id: 'rush', label: 'Рывок', tip: 'Обычная скорость, в середине резко быстро, потом снова обычная. Хорошо для переходов между сценами',
    points: [{ u: 0, s: 1 }, { u: 0.3, s: 1 }, { u: 0.5, s: 4 }, { u: 0.7, s: 1 }, { u: 1, s: 1 }] },
  { id: 'bullet', label: 'Пуля', tip: 'Быстро — очень медленно — быстро. Тот самый эффект из клипов',
    points: [{ u: 0, s: 2.5 }, { u: 0.35, s: 2.5 }, { u: 0.5, s: 0.2 }, { u: 0.65, s: 2.5 }, { u: 1, s: 2.5 }] },
  { id: 'speedup', label: 'Разгон', tip: 'Начинается медленно и плавно ускоряется',
    points: [{ u: 0, s: 0.5 }, { u: 0.5, s: 1 }, { u: 1, s: 3 }] },
  { id: 'slowdown', label: 'Торможение', tip: 'Начинается быстро и плавно замедляется до стоп-кадра почти',
    points: [{ u: 0, s: 3 }, { u: 0.5, s: 1 }, { u: 1, s: 0.3 }] },
];

const clampS = (s: number) => Math.max(RAMP_MIN, Math.min(RAMP_MAX, s));

/** Точки по порядку, без повторов, с началом в 0 и концом в 1 */
export function normRamp(points: RampPoint[]): RampPoint[] {
  const pts = points
    .filter(p => isFinite(p.u) && isFinite(p.s))
    .map(p => ({ u: Math.max(0, Math.min(1, p.u)), s: clampS(p.s) }))
    .sort((a, b) => a.u - b.u);
  if (!pts.length) return [{ u: 0, s: 1 }, { u: 1, s: 1 }];
  if (pts[0].u > 0) pts.unshift({ u: 0, s: pts[0].s });
  if (pts[pts.length - 1].u < 1) pts.push({ u: 1, s: pts[pts.length - 1].s });
  return pts;
}

// Плавный переход между точками, как у ключевых кадров
const smooth = (k: number) => k * k * (3 - 2 * k);

/** Скорость в точке u (0..1) исходного отрезка */
export function speedAt(points: RampPoint[], u: number): number {
  const pts = normRamp(points);
  if (u <= pts[0].u) return pts[0].s;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (u <= b.u) {
      const k = smooth((u - a.u) / Math.max(1e-6, b.u - a.u));
      // скорость меняем «в логарифме»: замедление ×0.25 и ускорение ×4 выглядят одинаково плавно
      return Math.exp(Math.log(a.s) + (Math.log(b.s) - Math.log(a.s)) * k);
    }
  }
  return pts[pts.length - 1].s;
}

export interface RampSegment { a: number; b: number; s: number; o: number } // от a до b секунд исходника, скорость s, начало o в готовом клипе

/**
 * Делит отрезок исходника длиной len на короткие куски с постоянной скоростью.
 * Куски одинаковой скорости склеиваются, чтобы FFmpeg не получал тысячи кусков.
 */
export function rampSegments(points: RampPoint[], len: number, maxParts = 90): RampSegment[] {
  const n = Math.max(1, Math.min(maxParts, Math.ceil(len / 0.08)));
  const raw: { a: number; b: number; s: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = (len * i) / n, b = (len * (i + 1)) / n;
    raw.push({ a, b, s: speedAt(points, (i + 0.5) / n) });
  }
  const merged: { a: number; b: number; s: number }[] = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(Math.log(last.s / r.s)) < 0.015) { last.b = r.b; last.s = (last.s + r.s) / 2; } else merged.push({ ...r });
  }
  let o = 0;
  return merged.map(r => {
    const seg = { a: r.a, b: r.b, s: Math.round(r.s * 1000) / 1000, o };
    o += (seg.b - seg.a) / seg.s;
    return seg;
  });
}

/** Сколько будет длиться клип после смены скорости */
export function rampDuration(points: RampPoint[], len: number): number {
  const segs = rampSegments(points, len);
  const last = segs[segs.length - 1];
  return last ? last.o + (last.b - last.a) / last.s : len;
}

const f = (v: number) => String(Math.round(v * 1e5) / 1e5);

/** Формула для setpts: время кадра в готовом клипе по времени T исходника (секунды от начала отрезка) */
export function rampExpr(segs: RampSegment[]): string {
  let e = '';
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    const piece = `(${f(s.o)}+(T-${f(s.a)})/${f(s.s)})`;
    e = e ? `if(lt(T,${f(s.b)}),${piece},${e})` : piece;
  }
  return e || 'T';
}

/** Цепочка atempo для скорости s (у фильтра предел 0.5..2 за один раз) */
export function tempoChain(s: number): string[] {
  const out: string[] = [];
  let k = s;
  while (k > 2) { out.push('atempo=2'); k /= 2; }
  while (k < 0.5) { out.push('atempo=0.5'); k /= 0.5; }
  if (Math.abs(k - 1) > 1e-4) out.push(`atempo=${f(k)}`);
  return out;
}

/** Граф фильтров FFmpeg для смены скорости: видео одной формулой, звук — кусками с atempo */
export function rampFilterGraph(points: RampPoint[], len: number, fps: number, hasAudio: boolean): { graph: string; maps: string[] } {
  const segs = rampSegments(points, len);
  const parts = [`[0:v]setpts=PTS-STARTPTS,setpts='${rampExpr(segs)}/TB',fps=${Math.max(1, Math.round(fps))}[v]`];
  const maps = ['[v]'];
  if (hasAudio) {
    const labels = segs.map((_, i) => `ra${i}`);
    parts.push(`[0:a]aresample=48000,asetpts=PTS-STARTPTS,asplit=${segs.length}${labels.map(l => `[${l}]`).join('')}`);
    segs.forEach((s, i) => {
      // у atempo на коротких кусках «теряются» доли секунды: добиваем каждый кусок тишиной до точной длины,
      // иначе к концу клипа звук отстанет от картинки
      const samples = Math.max(1, Math.round(((s.b - s.a) / s.s) * 48000));
      parts.push(`[${labels[i]}]atrim=start=${f(s.a)}:end=${f(s.b)},asetpts=PTS-STARTPTS${tempoChain(s.s).map(t => ',' + t).join('')},apad,atrim=end_sample=${samples}[rb${i}]`);
    });
    if (segs.length === 1) parts.push(`[rb0]anull[a]`);
    else parts.push(`${segs.map((_, i) => `[rb${i}]`).join('')}concat=n=${segs.length}:v=0:a=1[a]`);
    maps.push('[a]');
  }
  return { graph: parts.join(';'), maps };
}

/** Кривая для картинки: точки (u, скорость) — по ним рисуется линия в окне настроек */
export function rampCurve(points: RampPoint[], steps = 48): { u: number; s: number }[] {
  return Array.from({ length: steps + 1 }, (_, i) => ({ u: i / steps, s: speedAt(points, i / steps) }));
}
