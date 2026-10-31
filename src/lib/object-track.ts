// Слежение за объектом прямо на компьютере, без интернета: на первом кадре запоминаем, как выглядит
// предмет внутри рамки, и на каждом следующем кадре ищем самое похожее место рядом с прошлым.
import { mediaUrl } from '../api';
import { matchTemplate, patch, smoothSamples, toGray, type Box, type Gray, type Sample } from '../../shared/track';

function seek(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { v.removeEventListener('seeked', done); v.removeEventListener('error', fail); resolve(); };
    const fail = () => { v.removeEventListener('seeked', done); reject(new Error('Видео не открылось')); };
    v.addEventListener('seeked', done);
    v.addEventListener('error', fail);
    v.currentTime = t;
  });
}

export interface TrackResult { samples: Sample[]; lost: number } // lost — сколько кадров объект терялся

/**
 * Следим за объектом в файле path: box — рамка в момент at (доли кадра исходника),
 * от from до to секунд исходника. Идём вперёд от at до to и назад от at до from.
 */
export async function trackObject(path: string, box: Box, at: number, from: number, to: number,
  opts: { step?: number; signal?: AbortSignal; onProgress?: (k: number) => void } = {}): Promise<TrackResult> {
  const v = document.createElement('video');
  v.muted = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
  v.src = mediaUrl(path);
  await new Promise<void>((resolve, reject) => {
    v.addEventListener('loadeddata', () => resolve(), { once: true });
    v.addEventListener('error', () => reject(new Error('Видео не открылось')), { once: true });
  });
  const vw = v.videoWidth || 640, vh = v.videoHeight || 360;
  // кадр уменьшаем до 480 точек: так поиск быстрый, а точности хватает
  const W = Math.min(480, vw), H = Math.max(2, Math.round((W * vh) / vw));
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  const grab = async (t: number): Promise<Gray> => {
    await seek(v, Math.max(0, Math.min(t, (v.duration || to) - 0.03)));
    ctx.drawImage(v, 0, 0, W, H);
    return toGray(ctx.getImageData(0, 0, W, H).data, W, H);
  };
  const step = opts.step ?? 1 / 15;
  const bw = Math.max(8, Math.round(box.w * W)), bh = Math.max(8, Math.round(box.h * H));
  // образец объекта не больше 40 точек по большей стороне — иначе медленно
  const k = Math.min(1, 40 / Math.max(bw, bh));
  const tw = Math.max(6, Math.round(bw * k)), th = Math.max(6, Math.round(bh * k));
  const shrink = (g: Gray): Gray => {
    if (k >= 1) return g;
    const w = Math.max(2, Math.round(g.w * k)), h = Math.max(2, Math.round(g.h * k));
    const d = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = g.d[Math.min(g.h - 1, Math.floor(y / k)) * g.w + Math.min(g.w - 1, Math.floor(x / k))];
    return { w, h, d };
  };
  const first = shrink(await grab(at));
  const cx0 = (box.x + box.w / 2) * first.w, cy0 = (box.y + box.h / 2) * first.h;
  const tpl0 = patch(first, Math.round(cx0 - tw / 2), Math.round(cy0 - th / 2), tw, th);
  const total = Math.max(1, Math.ceil((to - from) / step));
  let doneCount = 0, lost = 0;

  const run = async (dir: 1 | -1): Promise<Sample[]> => {
    const out: Sample[] = [];
    let tpl = tpl0, cx = cx0, cy = cy0, vx = 0, vy = 0;
    // радиус поиска: объект за кадр сдвигается не дальше своего размера
    const r = Math.max(8, Math.round(Math.max(tw, th) * 0.9));
    for (let t = at + dir * step; dir > 0 ? t <= to + 1e-6 : t >= from - 1e-6; t += dir * step) {
      if (opts.signal?.aborted) throw new Error('Отменено');
      const img = shrink(await grab(t));
      // ищем там, куда объект должен был сдвинуться по прошлой скорости
      const m = matchTemplate(img, tpl, cx + vx, cy + vy, r);
      if (m.score > 0.45) {
        vx = (m.x - cx) * 0.6 + vx * 0.4; vy = (m.y - cy) * 0.6 + vy * 0.4;
        cx = m.x; cy = m.y;
        // образец понемногу обновляем, чтобы объект узнавался, даже если поворачивается
        if (m.score > 0.75) {
          const fresh = patch(img, Math.round(cx - tw / 2), Math.round(cy - th / 2), tw, th);
          const d = new Float32Array(tpl.d.length);
          for (let i = 0; i < d.length; i++) d[i] = tpl.d[i] * 0.85 + fresh.d[i] * 0.15;
          tpl = { w: tw, h: th, d };
        }
      } else {
        // объект закрыли или он ушёл из кадра: держим прошлое место и движение
        lost++;
        cx += vx * 0.5; cy += vy * 0.5;
      }
      out.push({ t: Math.round(t * 1000) / 1000, x: cx / img.w, y: cy / img.h, w: box.w, h: box.h });
      doneCount++;
      opts.onProgress?.(Math.min(1, doneCount / total));
    }
    return out;
  };
  try {
    const fwd = await run(1);
    const back = from < at - step / 2 ? await run(-1) : [];
    const samples = [...back.reverse(), { t: at, x: box.x + box.w / 2, y: box.y + box.h / 2, w: box.w, h: box.h }, ...fwd];
    return { samples: smoothSamples(samples, 2), lost };
  } finally {
    v.removeAttribute('src');
    v.load();
  }
}
