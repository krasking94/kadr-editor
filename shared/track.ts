// Слежение за объектом (motion tracking): программа находит выбранный предмет на каждом кадре,
// а надпись, стрелка или размытие едут за ним. Здесь — общая математика для просмотра, экспорта и тестов.
import type { Clip, FaceBlur, MediaClip, MediaItem, ObjectTrack, PathPoint, Project, TextClip } from './types';
import { croppedMedia, effectiveCrop } from './look';
import { clipDuration, transformAt } from './timeline';

// Размер слоя при масштабе 1 (как baseLayerSize в export-graph; своя копия, чтобы не было круговых импортов)
function baseLayerSize(m: Pick<MediaItem, 'width' | 'height'>, fit: 'fit' | 'fill', W: number, H: number) {
  const mw = m.width || W, mh = m.height || H;
  const k = fit === 'fill' ? Math.max(W / mw, H / mh) : Math.min(W / mw, H / mh);
  return { w: mw * k, h: mh * k };
}

export type Box = { x: number; y: number; w: number; h: number };
export type Sample = ObjectTrack['samples'][number];

/** Серое изображение (яркость 0..255) для поиска: маленькое, чтобы считать быстро */
export interface Gray { w: number; h: number; d: Float32Array }

export function toGray(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Gray {
  const d = new Float32Array(w * h);
  for (let i = 0, j = 0; i < d.length; i++, j += 4) d[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
  return { w, h, d };
}

/** Вырезать кусок картинки (образец объекта) в пикселях */
export function patch(img: Gray, x: number, y: number, w: number, h: number): Gray {
  const out = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    const yy = Math.max(0, Math.min(img.h - 1, y + j));
    for (let i = 0; i < w; i++) out[j * w + i] = img.d[yy * img.w + Math.max(0, Math.min(img.w - 1, x + i))];
  }
  return { w, h, d: out };
}

/**
 * Поиск образца tpl на картинке img рядом с точкой (cx, cy) в радиусе r пикселей
 * по нормированной взаимной корреляции: 1 — точное совпадение, 0 — ничего общего.
 * Сначала грубо (через пиксель), потом точно вокруг лучшего места.
 */
export function matchTemplate(img: Gray, tpl: Gray, cx: number, cy: number, r: number): { x: number; y: number; score: number } {
  const tw = tpl.w, th = tpl.h, n = tw * th;
  let tm = 0;
  for (let i = 0; i < n; i++) tm += tpl.d[i];
  tm /= n;
  const tz = new Float32Array(n);
  let tn = 0;
  for (let i = 0; i < n; i++) { tz[i] = tpl.d[i] - tm; tn += tz[i] * tz[i]; }
  tn = Math.sqrt(tn) || 1;
  const score = (x0: number, y0: number) => {
    if (x0 < 0 || y0 < 0 || x0 + tw > img.w || y0 + th > img.h) return -2;
    let s = 0, sm = 0, ss = 0;
    for (let j = 0; j < th; j++) {
      const row = (y0 + j) * img.w + x0, trow = j * tw;
      for (let i = 0; i < tw; i++) {
        const v = img.d[row + i];
        s += v * tz[trow + i]; sm += v; ss += v * v;
      }
    }
    const varI = ss - (sm * sm) / n;
    return varI <= 1e-6 ? 0 : s / (Math.sqrt(varI) * tn);
  };
  let best = -2, bx = Math.round(cx - tw / 2), by = Math.round(cy - th / 2);
  const x0 = Math.round(cx - tw / 2), y0 = Math.round(cy - th / 2);
  for (let dy = -r; dy <= r; dy += 2) for (let dx = -r; dx <= r; dx += 2) {
    const v = score(x0 + dx, y0 + dy);
    if (v > best) { best = v; bx = x0 + dx; by = y0 + dy; }
  }
  const gx = bx, gy = by;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const v = score(gx + dx, gy + dy);
    if (v > best) { best = v; bx = gx + dx; by = gy + dy; }
  }
  return { x: bx + tw / 2, y: by + th / 2, score: best };
}

/** Сгладить дрожание: каждая точка — среднее соседей (окно 2k+1) */
export function smoothSamples(s: Sample[], k = 2): Sample[] {
  return s.map((p, i) => {
    let x = 0, y = 0, w = 0, h = 0, n = 0;
    for (let j = Math.max(0, i - k); j <= Math.min(s.length - 1, i + k); j++) { x += s[j].x; y += s[j].y; w += s[j].w; h += s[j].h; n++; }
    return { t: p.t, x: x / n, y: y / n, w: w / n, h: h / n };
  });
}

/** Где объект в момент src (время исходника): между образцами — по прямой */
export function trackAt(tr: ObjectTrack, src: number): Sample | null {
  const s = tr.samples;
  if (!s.length) return null;
  if (src <= s[0].t) return s[0];
  for (let i = 1; i < s.length; i++) {
    if (src <= s[i].t) {
      const a = s[i - 1], b = s[i], k = (src - a.t) / Math.max(1e-6, b.t - a.t);
      return { t: src, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, w: a.w + (b.w - a.w) * k, h: a.h + (b.h - a.h) * k };
    }
  }
  return s[s.length - 1];
}

/** Точка исходника (доли кадра файла) → точка готового кадра (доли кадра проекта) с учётом обрезки, размера и поворота */
export function sourceToFrame(c: MediaClip, m: MediaItem, W: number, H: number, local: number, sx: number, sy: number): { x: number; y: number } {
  const cr = effectiveCrop(c, m);
  let cx = (sx - cr.l) / Math.max(1e-6, 1 - cr.l - cr.r), cy = (sy - cr.t) / Math.max(1e-6, 1 - cr.t - cr.b);
  if (c.effects.flipH) cx = 1 - cx;
  if (c.effects.flipV) cy = 1 - cy;
  const tr = transformAt(c, local);
  const base = baseLayerSize(croppedMedia(m, c), c.fit, W, H);
  const w = base.w * tr.scale, h = base.h * tr.scale;
  const dx = (cx - 0.5) * w, dy = (cy - 0.5) * h;
  const a = (tr.rotation * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  return { x: (tr.x * W + dx * cos - dy * sin) / W, y: (tr.y * H + dx * sin + dy * cos) / H };
}

/** Обратно: точка кадра проекта → точка исходника (для рамки, которую рисуют мышкой в окне просмотра) */
export function frameToSource(c: MediaClip, m: MediaItem, W: number, H: number, local: number, fx: number, fy: number): { x: number; y: number } {
  const tr = transformAt(c, local);
  const base = baseLayerSize(croppedMedia(m, c), c.fit, W, H);
  const w = base.w * tr.scale, h = base.h * tr.scale;
  const px = fx * W - tr.x * W, py = fy * H - tr.y * H;
  const a = (-tr.rotation * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  let cx = (px * cos - py * sin) / Math.max(1e-6, w) + 0.5, cy = (px * sin + py * cos) / Math.max(1e-6, h) + 0.5;
  if (c.effects.flipH) cx = 1 - cx;
  if (c.effects.flipV) cy = 1 - cy;
  const cr = effectiveCrop(c, m);
  return { x: cr.l + cx * (1 - cr.l - cr.r), y: cr.t + cy * (1 - cr.t - cr.b) };
}

/** Где объект в кадре проекта в момент time таймлайна (или null, если клип в это время не виден) */
export function objectAt(p: Project, src: MediaClip, time: number): { x: number; y: number } | null {
  const m = p.media.find(x => x.id === src.mediaId);
  if (!m || !src.track?.samples.length) return null;
  const local = Math.max(0, Math.min(clipDuration(src), time - src.start));
  const s = trackAt(src.track, src.in + local * src.speed);
  return s ? sourceToFrame(src, m, p.width, p.height, local, s.x, s.y) : null;
}

const findMedia = (p: Project, id: string): MediaClip | null => {
  for (const t of p.tracks) for (const c of t.clips) if (c.id === id && c.type === 'media') return c;
  return null;
};

/**
 * «Едет за объектом»: превращает ссылку follow в обычный путь движения на время клипа.
 * Картинке пишется path (центр слоя), тексту — сдвиг от его места (TextClip.path).
 * Вызывается перед просмотром и экспортом, поэтому если двигать клипы, слой всё равно едет за объектом.
 */
export function resolveFollows(p: Project, step = 1 / 15): void {
  for (const t of p.tracks) for (const c of t.clips) {
    if (!c.follow || c.follow.baked) continue;
    const src = findMedia(p, c.follow.clipId);
    if (!src || src.id === c.id || !src.track?.samples.length) { if (c.type === 'text') delete c.path; continue; }
    const dur = clipDuration(c as Clip);
    const ref = objectAt(p, src, Math.max(src.start, Math.min(src.start + clipDuration(src), c.start)));
    if (!ref) continue;
    const pts: PathPoint[] = [];
    for (let k = 0; k <= dur + 1e-6; k += step) {
      const o = objectAt(p, src, c.start + k);
      if (!o) continue;
      pts.push({ t: Math.round(k * 1000) / 1000, x: o.x - ref.x, y: o.y - ref.y });
    }
    if (!pts.length) continue;
    if (c.type === 'text') (c as TextClip).path = pts;
    else {
      const mc = c as MediaClip;
      const base = transformAt({ ...mc, path: undefined }, 0);
      mc.path = pts.map(q => ({ t: q.t, x: base.x + q.x, y: base.y + q.y }));
    }
  }
}

/** Сдвиг текста, который едет за объектом, в момент local (от начала текста) */
export function textShift(c: TextClip, local: number): { x: number; y: number } {
  const pts = c.path;
  if (!c.follow || !pts?.length) return { x: 0, y: 0 };
  if (local <= pts[0].t) return pts[0];
  for (let i = 1; i < pts.length; i++) {
    if (local < pts[i].t) {
      const a = pts[i - 1], b = pts[i], k = (local - a.t) / Math.max(1e-6, b.t - a.t);
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    }
  }
  return pts[pts.length - 1];
}

/**
 * Рамки объекта превращаем в «маску размытия» — тот же механизм, что размывает лица.
 * Если лица в клипе уже размыты, объект добавляется к ним.
 */
export function trackToBlur(tr: ObjectTrack, from: number, to: number, prev?: FaceBlur, strength = 0.7): FaceBlur {
  const step = prev?.step || 0.2;
  const t0 = prev?.samples.length ? prev.samples[0].t : from;
  const samples: FaceBlur['samples'] = prev?.samples.map(s => ({ t: s.t, boxes: s.boxes.map(b => [...b] as [number, number, number, number]) })) || [];
  const at = (t: number) => {
    const i = Math.round((t - t0) / step);
    while (samples.length <= i) samples.push({ t: Math.round((t0 + samples.length * step) * 1000) / 1000, boxes: [] });
    return i >= 0 ? samples[i] : null;
  };
  for (let t = Math.max(from, t0); t <= to + 1e-6; t += step) {
    const s = trackAt(tr, t);
    const slot = at(t);
    if (!s || !slot) continue;
    // у лиц маска чуть больше рамки; объекту запас не нужен, поэтому рамку немного сжимаем обратно
    const k = 1 / 1.35;
    slot.boxes.push([s.x - (s.w * k) / 2, s.y - (s.h * k) / 2, s.w * k, s.h * k]);
  }
  return { strength: prev?.strength ?? strength, step, samples };
}

/** Есть ли в проекте слой, который едет за этим клипом */
export const followers = (p: Project, clipId: string) => p.tracks.flatMap(t => t.clips).filter(c => c.follow?.clipId === clipId);
