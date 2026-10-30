// Ключевые кадры: в разные моменты клипа задаём положение, размер, поворот и прозрачность,
// а между ними программа сама плавно ведёт картинку. Одна и та же математика для просмотра и экспорта.
import type { Keyframe, MediaClip, Transform } from './types';

export const KEY_PROPS = ['x', 'y', 'scale', 'rotation', 'opacity'] as const;
export type KeyProp = (typeof KEY_PROPS)[number];

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

// Длительность клипа на таймлайне (как clipDuration, но без зависимости от timeline.ts)
const lengthOf = (c: MediaClip) => (c.out - c.in) / c.speed;

/**
 * Ключи клипа по порядку. Если ключей нет, движение «от начала к концу» (animate) тоже
 * превращается в два ключа — так у просмотра и экспорта один общий путь.
 */
export function keysOf(c: MediaClip): Keyframe[] {
  if (c.keys?.length) return c.keys.slice().sort((a, b) => a.t - b.t);
  if (c.animate) return [{ t: 0, ...c.transform, ease: 'linear' }, { t: lengthOf(c), ...c.transformEnd, ease: 'linear' }];
  return [{ t: 0, ...c.transform }];
}

// Плавный разгон и торможение: в начале и в конце отрезка движение медленнее
const smooth = (u: number) => u * u * (3 - 2 * u);

export function valueAt(keys: Keyframe[], prop: KeyProp, t: number): number {
  if (t <= keys[0].t) return keys[0][prop];
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i];
    if (t < b.t) {
      let u = (t - a.t) / Math.max(1e-3, b.t - a.t);
      if (a.ease !== 'linear') u = smooth(u);
      return a[prop] + (b[prop] - a[prop]) * u;
    }
  }
  return keys[keys.length - 1][prop];
}

export function transformAtKeys(keys: Keyframe[], t: number): Transform {
  return { x: valueAt(keys, 'x', t), y: valueAt(keys, 'y', t), scale: valueAt(keys, 'scale', t), rotation: valueAt(keys, 'rotation', t), opacity: valueAt(keys, 'opacity', t) };
}

export const isStatic = (keys: Keyframe[], prop: KeyProp) => keys.every(k => k[prop] === keys[0][prop]);
export const range = (keys: Keyframe[], prop: KeyProp) => ({ min: Math.min(...keys.map(k => k[prop])), max: Math.max(...keys.map(k => k[prop])) });

/**
 * То же значение формулой для FFmpeg: T — выражение времени от начала клипа,
 * map — во что превратить значение (например, градусы в радианы).
 */
export function keyExpr(keys: Keyframe[], prop: KeyProp, T: string, map: (v: number) => number = v => v): string {
  const n = (v: number) => String(r6(map(v)));
  if (isStatic(keys, prop)) return n(keys[0][prop]);
  let e = n(keys[keys.length - 1][prop]);
  for (let i = keys.length - 2; i >= 0; i--) {
    const a = keys[i], b = keys[i + 1];
    const va = map(a[prop]), vb = map(b[prop]);
    const dt = Math.max(1e-3, b.t - a.t);
    let seg: string;
    if (va === vb) seg = n(a[prop]);
    else {
      const u = `clip((${T}-${r6(a.t)})/${r6(dt)},0,1)`;
      const k = a.ease === 'linear' ? u : `(${u}*${u}*(3-2*${u}))`;
      seg = `(${r6(va)}+(${r6(vb - va)})*${k})`;
    }
    e = `if(lt(${T},${r6(b.t)}),${seg},${e})`;
  }
  return keys[0].t > 0 ? `if(lt(${T},${r6(keys[0].t)}),${n(keys[0][prop])},${e})` : e;
}

// Ключи ближе этого считаются одним (примерно кадр)
export const KEY_SNAP = 1 / 30;

/**
 * Поставить ключ в момент t (от начала клипа) и поменять в нём значения.
 * Если ключей ещё не было, текущее положение (или движение от начала к концу) становится первыми ключами.
 */
export function setKeyAt(c: MediaClip, t: number, patch: Partial<Transform> = {}): Keyframe[] {
  const len = lengthOf(c);
  const time = r6(Math.max(0, Math.min(len, t)));
  const keys = keysOf(c).map(k => ({ ...k }));
  const i = keys.findIndex(k => Math.abs(k.t - time) < KEY_SNAP);
  if (i >= 0) {
    Object.assign(keys[i], patch);
    return keys;
  }
  const here: Keyframe = { t: time, ...transformAtKeys(keys, time), ...patch, ease: 'smooth' };
  // первый ключ появился не в начале клипа — до него клип стоит как в начале
  return [...keys, here].sort((a, b) => a.t - b.t);
}

export function removeKey(c: MediaClip, t: number): Keyframe[] {
  return keysOf(c).filter(k => Math.abs(k.t - t) >= KEY_SNAP / 2);
}
