// Живой просмотр хромакея и LUT: кадр видео или фото перерисовывается на холсте с обработкой каждой точки.
// Формулы те же, что у фильтров FFmpeg (colorkey и lut3d), поэтому в готовом видео будет так же.
import { useEffect, useRef, type RefObject } from 'react';
import { api } from '../api';
import type { ChromaKey, ColorWheels } from '../../shared/types';
import { applyWheels, hasWheels } from '../../shared/look';

interface Lut { size: number; data: Float32Array }
const luts = new Map<string, Promise<Lut | null>>();

export function parseCube(text: string): Lut | null {
  let size = 0;
  const vals: number[] = [];
  let min = [0, 0, 0], max = [1, 1, 1];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('TITLE')) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'LUT_3D_SIZE') { size = Number(parts[1]); continue; }
    if (parts[0] === 'DOMAIN_MIN') { min = parts.slice(1, 4).map(Number); continue; }
    if (parts[0] === 'DOMAIN_MAX') { max = parts.slice(1, 4).map(Number); continue; }
    if (/^[-\d.]/.test(parts[0]) && parts.length >= 3) for (let i = 0; i < 3; i++) vals.push((Number(parts[i]) - min[i]) / ((max[i] - min[i]) || 1));
  }
  if (!size || vals.length < size * size * size * 3) return null;
  return { size, data: new Float32Array(vals.slice(0, size * size * size * 3)) };
}

function loadLut(path: string): Promise<Lut | null> {
  if (!luts.has(path)) luts.set(path, api.readText(path).then(parseCube).catch(() => null));
  return luts.get(path)!;
}

function applyLut(px: Uint8ClampedArray, lut: Lut) {
  const N = lut.size, d = lut.data, s = (N - 1) / 255;
  const N2 = N * N;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i] * s, g = px[i + 1] * s, b = px[i + 2] * s;
    const r0 = r | 0, g0 = g | 0, b0 = b | 0;
    const r1 = Math.min(N - 1, r0 + 1), g1 = Math.min(N - 1, g0 + 1), b1 = Math.min(N - 1, b0 + 1);
    const fr = r - r0, fg = g - g0, fb = b - b0;
    for (let ch = 0; ch < 3; ch++) {
      const at = (ri: number, gi: number, bi: number) => d[(ri + gi * N + bi * N2) * 3 + ch];
      const c00 = at(r0, g0, b0) * (1 - fr) + at(r1, g0, b0) * fr;
      const c10 = at(r0, g1, b0) * (1 - fr) + at(r1, g1, b0) * fr;
      const c01 = at(r0, g0, b1) * (1 - fr) + at(r1, g0, b1) * fr;
      const c11 = at(r0, g1, b1) * (1 - fr) + at(r1, g1, b1) * fr;
      const c0 = c00 * (1 - fg) + c10 * fg, c1 = c01 * (1 - fg) + c11 * fg;
      px[i + ch] = (c0 * (1 - fb) + c1 * fb) * 255;
    }
  }
}

function applyKey(px: Uint8ClampedArray, key: ChromaKey) {
  const n = parseInt(key.color.replace('#', '').slice(0, 6).padEnd(6, '0'), 16);
  const kr = (n >> 16) & 255, kg = (n >> 8) & 255, kb = n & 255;
  const sim = key.similarity, blend = key.blend, norm = 1 / (255 * 255 * 3);
  for (let i = 0; i < px.length; i += 4) {
    const dr = px[i] - kr, dg = px[i + 1] - kg, db = px[i + 2] - kb;
    const diff = Math.sqrt((dr * dr + dg * dg + db * db) * norm);
    const a = blend > 0.0001 ? Math.min(1, Math.max(0, (diff - sim) / blend)) : diff > sim ? 1 : 0;
    px[i + 3] = px[i + 3] * a;
  }
}

export function PixelFx({ source, keyColor, lut, wheels, w, h, playing, t }: {
  source: RefObject<HTMLVideoElement | HTMLImageElement | null>; keyColor?: ChromaKey; lut?: string; wheels?: ColorWheels; w: number; h: number; playing: boolean; t: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const lutRef = useRef<Lut | null>(null);
  const draw = useRef<() => void>(() => undefined);

  draw.current = () => {
    const cv = ref.current, src = source.current;
    if (!cv || !src) return;
    const ready = src instanceof HTMLVideoElement ? src.readyState >= 2 : src.complete && src.naturalWidth > 0;
    if (!ready) return;
    // во время просмотра считаем в меньшем размере, чтобы не тормозило
    const maxW = playing ? 640 : 1280;
    const cw = Math.max(2, Math.round(Math.min(w, maxW))), ch = Math.max(2, Math.round((cw * h) / Math.max(1, w)));
    if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
    const ctx = cv.getContext('2d', { willReadFrequently: true })!;
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(src, 0, 0, cw, ch);
    const img = ctx.getImageData(0, 0, cw, ch);
    if (lut && lutRef.current) applyLut(img.data, lutRef.current);
    if (hasWheels(wheels)) applyWheels(img.data, wheels!);
    if (keyColor) applyKey(img.data, keyColor);
    ctx.putImageData(img, 0, 0);
  };

  useEffect(() => {
    let alive = true;
    lutRef.current = null;
    if (lut) loadLut(lut).then(l => { if (alive) { lutRef.current = l; draw.current(); } });
    return () => { alive = false; };
  }, [lut]);

  // при просмотре — каждый кадр, на паузе — после перемотки и при смене настроек
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const loop = () => { draw.current(); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing]);
  useEffect(() => {
    const src = source.current;
    if (!src) return;
    const h2 = () => draw.current();
    src.addEventListener('seeked', h2);
    src.addEventListener('loadeddata', h2);
    src.addEventListener('load', h2);
    return () => { src.removeEventListener('seeked', h2); src.removeEventListener('loadeddata', h2); src.removeEventListener('load', h2); };
  }, [source.current]);
  useEffect(() => { if (!playing) draw.current(); }, [t, w, h, keyColor?.color, keyColor?.similarity, keyColor?.blend, lut, JSON.stringify(wheels), playing]);

  return <canvas ref={ref} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />;
}
