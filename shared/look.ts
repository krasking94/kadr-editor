// Внешний вид слоя (с 0.7): режимы наложения, обрезка и форма, цветовые круги, размытие лиц, эквалайзер.
// Одни и те же расчёты для окна просмотра и для экспорта, поэтому готовое видео совпадает с просмотром.
import type { AudioEq, BlendMode, ColorWheels, Crop, FaceBlur, MaskShape, MediaClip, MediaItem, Wheel } from './types';

const n = (v: number, d = 4) => {
  const s = (Math.round(v * 10 ** d) / 10 ** d).toString();
  return s === '-0' ? '0' : s;
};
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

// ── Режимы наложения ─────────────────────────────────
// swap: в FFmpeg формула «перекрытия» смотрит на первый вход, а в браузере — на нижний слой.
// Чтобы просмотр совпадал с готовым видео, для таких режимов входы меняются местами.
export const BLEND_MODES: { id: BlendMode; label: string; tip: string; css: string; ff: string; swap?: boolean }[] = [
  { id: 'normal', label: 'Обычный', tip: 'Слой просто лежит сверху', css: 'normal', ff: '' },
  { id: 'screen', label: 'Экран', tip: 'Светлое проступает, чёрное исчезает. Для бликов, огня, пыли и света на чёрном фоне', css: 'screen', ff: 'screen' },
  { id: 'add', label: 'Сложение', tip: 'Как «Экран», только ярче: свет складывается', css: 'plus-lighter', ff: 'addition' },
  { id: 'lighten', label: 'Светлее', tip: 'Из двух точек остаётся более светлая', css: 'lighten', ff: 'lighten' },
  { id: 'multiply', label: 'Умножение', tip: 'Тёмное проступает, белое исчезает. Для текстур бумаги и рисунков на белом', css: 'multiply', ff: 'multiply' },
  { id: 'darken', label: 'Темнее', tip: 'Из двух точек остаётся более тёмная', css: 'darken', ff: 'darken' },
  { id: 'overlay', label: 'Перекрытие', tip: 'Слой добавляет контраст и цвет, сохраняя света и тени картинки', css: 'overlay', ff: 'overlay', swap: true },
  { id: 'softlight', label: 'Мягкий свет', tip: 'Как «Перекрытие», только нежнее', css: 'soft-light', ff: 'softlight' },
  { id: 'difference', label: 'Разница', tip: 'Цвета вычитаются: необычный психоделический эффект', css: 'difference', ff: 'difference' },
];

export const blendOf = (id?: BlendMode) => BLEND_MODES.find(b => b.id === id) ?? BLEND_MODES[0];

// ── Обрезка и форма ──────────────────────────────────
export const NO_CROP: Crop = { l: 0, r: 0, t: 0, b: 0 };

export const MASKS: { id: MaskShape; label: string; tip: string }[] = [
  { id: 'none', label: 'Прямоугольник', tip: 'Как снято' },
  { id: 'rounded', label: 'Скруглённый', tip: 'Мягкие углы, как у карточек в приложениях' },
  { id: 'ellipse', label: 'Овал', tip: 'Видео внутри овала' },
  { id: 'circle', label: 'Круг', tip: 'Ровный круг по центру кадра, как кружочки в Telegram' },
];

/** Сколько срезать с каждого края (доли исходника). Для круга лишнее по длинной стороне срезается само. */
export function effectiveCrop(c: Pick<MediaClip, 'crop' | 'mask'>, m: Pick<MediaItem, 'width' | 'height'>): Crop {
  const src = c.crop || NO_CROP;
  let l = clamp(src.l || 0, 0, 0.9), r = clamp(src.r || 0, 0, 0.9), t = clamp(src.t || 0, 0, 0.9), b = clamp(src.b || 0, 0, 0.9);
  if (l + r > 0.95) { const k = 0.95 / (l + r); l *= k; r *= k; }
  if (t + b > 0.95) { const k = 0.95 / (t + b); t *= k; b *= k; }
  if (c.mask === 'circle' && m.width && m.height) {
    const w = (1 - l - r) * m.width, h = (1 - t - b) * m.height;
    if (w > h) { const e = (w - h) / m.width / 2; l += e; r += e; }
    else if (h > w) { const e = (h - w) / m.height / 2; t += e; b += e; }
  }
  return { l, r, t, b };
}

export const hasCrop = (cr: Crop) => cr.l > 1e-4 || cr.r > 1e-4 || cr.t > 1e-4 || cr.b > 1e-4;

/** Размер файла после обрезки — от него считается размер слоя в кадре */
export function croppedMedia<T extends Pick<MediaItem, 'width' | 'height'>>(m: T, c: Pick<MediaClip, 'crop' | 'mask'>): T {
  if (!c.crop && (!c.mask || c.mask === 'none')) return m;
  const cr = effectiveCrop(c, m);
  if (!hasCrop(cr)) return m;
  return { ...m, width: Math.max(2, (m.width || 0) * (1 - cr.l - cr.r)), height: Math.max(2, (m.height || 0) * (1 - cr.t - cr.b)) };
}

export function cropFilter(cr: Crop): string {
  if (!hasCrop(cr)) return '';
  return `crop=w='2*trunc(iw*${n(1 - cr.l - cr.r)}/2)':h='2*trunc(ih*${n(1 - cr.t - cr.b)}/2)':x='iw*${n(cr.l)}':y='ih*${n(cr.t)}'`;
}

const ROUND = 0.12; // радиус скругления, доля короткой стороны

/** Форма слоя для окна просмотра (CSS clip-path) */
export function maskCss(shape: MaskShape | undefined, w: number, h: number): string | undefined {
  if (!shape || shape === 'none') return undefined;
  if (shape === 'rounded') return `inset(0 round ${n(ROUND * Math.min(w, h), 1)}px)`;
  return 'ellipse(50% 50% at 50% 50%)';
}

/** Форма слоя для FFmpeg: множитель прозрачности с мягким краем шириной около пикселя */
export function maskFilter(shape: MaskShape | undefined): string {
  if (!shape || shape === 'none') return '';
  let k: string;
  if (shape === 'rounded') {
    const R = `(${ROUND}*min(W,H))`;
    const dx = `max(abs(X+0.5-W/2)-(W/2-${R}),0)`, dy = `max(abs(Y+0.5-H/2)-(H/2-${R}),0)`;
    k = `clip(${R}-hypot(${dx},${dy})+0.5,0,1)`;
  } else {
    k = `clip((1-hypot((X+0.5-W/2)/(W/2),(Y+0.5-H/2)/(H/2)))*min(W,H)/2+0.5,0,1)`;
  }
  return `geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='alpha(X,Y)*${k}'`;
}

// ── Цветовые круги ───────────────────────────────────
export const NO_WHEEL: Wheel = { hue: 0, amount: 0 };
export const defaultWheels = (): ColorWheels => ({ shadows: { ...NO_WHEEL }, midtones: { ...NO_WHEEL }, highlights: { ...NO_WHEEL } });

const WHEEL_MAX = 0.5; // самый сильный сдвиг цвета на краю круга

/** Сдвиг красного, зелёного и синего по положению точки на круге (0° — красный, 120° — зелёный, 240° — синий) */
export function wheelRgb(w: Wheel): [number, number, number] {
  const a = clamp(w.amount, 0, 1) * WHEEL_MAX, h = (w.hue * Math.PI) / 180;
  return [a * Math.cos(h), a * Math.cos(h - (2 * Math.PI) / 3), a * Math.cos(h - (4 * Math.PI) / 3)];
}

export const hasWheels = (w?: ColorWheels) => !!w && (w.shadows.amount > 1e-3 || w.midtones.amount > 1e-3 || w.highlights.amount > 1e-3);

export function wheelsFilter(w?: ColorWheels): string {
  if (!hasWheels(w)) return '';
  const [rs, gs, bs] = wheelRgb(w!.shadows), [rm, gm, bm] = wheelRgb(w!.midtones), [rh, gh, bh] = wheelRgb(w!.highlights);
  return `colorbalance=rs=${n(rs)}:gs=${n(gs)}:bs=${n(bs)}:rm=${n(rm)}:gm=${n(gm)}:bm=${n(bm)}:rh=${n(rh)}:gh=${n(gh)}:bh=${n(bh)}`;
}

/**
 * То же, что фильтр colorbalance в FFmpeg, для просмотра на холсте.
 * Формула сверена с FFmpeg 6: вес теней, середины и светов зависит от суммы самого яркого и самого тёмного канала.
 */
export function applyWheels(px: Uint8ClampedArray, w: ColorWheels) {
  const s = wheelRgb(w.shadows), m = wheelRgb(w.midtones), h = wheelRgb(w.highlights);
  const A = 4, B = 0.333, K = 0.7;
  const c01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
    const l = Math.max(r, g, b) + Math.min(r, g, b);
    const ws = c01((B - l) * A + 0.5) * K;
    const wm = c01((l - B) * A + 0.5) * c01((1 - l - B) * A + 0.5) * K;
    const wh = c01((l + B - 1) * A + 0.5) * K;
    px[i] = c01(r + s[0] * ws + m[0] * wm + h[0] * wh) * 255;
    px[i + 1] = c01(g + s[1] * ws + m[1] * wm + h[1] * wh) * 255;
    px[i + 2] = c01(b + s[2] * ws + m[2] * wm + h[2] * wh) * 255;
  }
}

// ── Размытие лиц ─────────────────────────────────────
/** Лица в момент src (секунды исходника): ближайший образец */
export function facesAt(f: FaceBlur | undefined, src: number): [number, number, number, number][] {
  if (!f?.samples.length) return [];
  const i = Math.round((src - f.samples[0].t) / (f.step || 0.25));
  const s = f.samples[Math.max(0, Math.min(f.samples.length - 1, i))];
  return Math.abs(s.t - src) <= (f.step || 0.25) * 1.5 ? s.boxes : [];
}

/** Рамка лица с запасом: размываем чуть больше, чтобы не торчали уши и волосы */
export function padBox([x, y, w, h]: [number, number, number, number]): [number, number, number, number] {
  const k = 1.35;
  return [x - (w * (k - 1)) / 2, y - (h * (k - 1)) / 2 - h * 0.06, w * k, h * (k + 0.1)];
}

/** Сила размытия: радиус в пикселях исходника */
export const faceBlurRadius = (f: FaceBlur, m: Pick<MediaItem, 'width' | 'height'>) =>
  Math.max(4, Math.round(Math.min(m.width || 640, m.height || 360) * (0.015 + clamp(f.strength, 0, 1) * 0.045)));

// ── Звук: эквалайзер и компрессор ────────────────────
export const NO_EQ: AudioEq = { low: 0, mid: 0, high: 0, comp: 0 };
export const hasEq = (e?: AudioEq) => !!e && (Math.abs(e.low) > 0.05 || Math.abs(e.mid) > 0.05 || Math.abs(e.high) > 0.05 || e.comp > 0.01);

export const EQ_PRESETS: { id: string; label: string; tip: string; eq: AudioEq }[] = [
  { id: 'flat', label: 'Как есть', tip: 'Без обработки', eq: NO_EQ },
  { id: 'voice', label: 'Чёткий голос', tip: 'Меньше гула, больше разборчивости', eq: { low: -4, mid: 2, high: 3, comp: 0.4 } },
  { id: 'radio', label: 'Радиоведущий', tip: 'Плотный бархатный голос, ровная громкость', eq: { low: 3, mid: 1, high: 2, comp: 0.8 } },
  { id: 'bass', label: 'Больше басов', tip: 'Для музыки', eq: { low: 6, mid: 0, high: 1, comp: 0 } },
  { id: 'phone', label: 'Как по телефону', tip: 'Голос из трубки: только середина', eq: { low: -12, mid: 6, high: -12, comp: 0.5 } },
  { id: 'soft', label: 'Мягче', tip: 'Убрать резкие шипящие и звон', eq: { low: 1, mid: 0, high: -5, comp: 0 } },
];

export function eqFilters(e?: AudioEq): string[] {
  if (!hasEq(e)) return [];
  const f: string[] = [];
  const db = (v: number) => n(clamp(v, -15, 15), 2);
  if (Math.abs(e!.low) > 0.05) f.push(`bass=g=${db(e!.low)}:f=120:w=0.7`);
  if (Math.abs(e!.mid) > 0.05) f.push(`equalizer=f=1200:t=q:w=0.9:g=${db(e!.mid)}`);
  if (Math.abs(e!.high) > 0.05) f.push(`treble=g=${db(e!.high)}:f=5500:w=0.7`);
  if (e!.comp > 0.01) {
    const c = clamp(e!.comp, 0, 1);
    f.push(`acompressor=threshold=${n(-12 - c * 16, 1)}dB:ratio=${n(2 + c * 4, 2)}:attack=6:release=150:makeup=${n(1 + c * 3, 2)}`);
  }
  return f;
}
