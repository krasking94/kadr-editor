// Поиск лица в видео без интернета (MediaPipe BlazeFace) и плавная «камера» для вертикального кадра.
import { get } from '../state/store';
import { mediaUrl } from '../api';
import { simplifyPath } from '../../shared/speech';

type Detector = { detect: (img: HTMLCanvasElement) => { detections: { boundingBox?: { originX: number; originY: number; width: number; height: number }; categories?: { score: number }[] }[] }; close: () => void };

let detectorPromise: Promise<Detector> | null = null;

// Файлы движка лежат рядом с программой; при разработке их отдаёт сервер Vite
function assetUrl(rel: string): string {
  if (location.protocol.startsWith('http')) return new URL('./' + rel, location.href).href;
  const dir = get().info?.assetsDir || '';
  const sep = dir.includes('\\') ? '\\' : '/';
  return mediaUrl(dir + sep + rel.replace(/\//g, sep));
}

export function faceDetector(): Promise<Detector> {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const vision = await import('@mediapipe/tasks-vision');
      const fileset = { wasmLoaderPath: assetUrl('mediapipe/vision_wasm_internal.js'), wasmBinaryPath: assetUrl('mediapipe/vision_wasm_internal.wasm') };
      return (await vision.FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: assetUrl('models/face_detector.tflite'), delegate: 'CPU' },
        runningMode: 'IMAGE', minDetectionConfidence: 0.45,
      })) as unknown as Detector;
    })();
    detectorPromise.catch(() => { detectorPromise = null; });
  }
  return detectorPromise;
}

function seek(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { v.removeEventListener('seeked', done); v.removeEventListener('error', fail); resolve(); };
    const fail = () => { v.removeEventListener('seeked', done); reject(new Error('Видео не открылось')); };
    v.addEventListener('seeked', done);
    v.addEventListener('error', fail);
    v.currentTime = t;
  });
}

export interface FaceSample { t: number; x: number; y: number; found: boolean }

/** Где лицо в кадре: центр самого крупного лица (доли ширины и высоты исходника) каждые step секунд исходника */
export async function trackFaces(path: string, from: number, to: number, opts: { step?: number; onProgress?: (p: number) => void; signal?: AbortSignal } = {}): Promise<FaceSample[]> {
  const det = await faceDetector();
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.crossOrigin = 'anonymous'; // иначе холст «испачкается» и кадр нельзя будет прочитать
  v.src = mediaUrl(path);
  await new Promise<void>((resolve, reject) => {
    v.addEventListener('loadeddata', () => resolve(), { once: true });
    v.addEventListener('error', () => reject(new Error('Видео не открылось')), { once: true });
  });
  const vw = v.videoWidth, vh = v.videoHeight;
  const cw = 640, ch = Math.max(2, Math.round((cw * vh) / Math.max(1, vw)));
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  // Детектор видит кадр в маленьком размере, и далёкое лицо теряется.
  // Поэтому, если на целом кадре лица нет, смотрим три квадратных куска: слева, по центру и справа.
  const T = 384, side = Math.min(vw, vh), long = Math.max(vw, vh) - side;
  const tile = document.createElement('canvas');
  tile.width = T; tile.height = T;
  const tctx = tile.getContext('2d', { willReadFrequently: true })!;
  type Box = { x: number; y: number; area: number };
  const boxes = (res: ReturnType<Detector['detect']>, map: (b: { originX: number; originY: number; width: number; height: number }) => Box) =>
    res.detections.filter(d => d.boundingBox).map(d => map(d.boundingBox!));
  const step = opts.step ?? 0.25;
  const out: FaceSample[] = [];
  let prev: { x: number; y: number } | null = null;
  try {
    for (let t = from; t <= to + 1e-3; t += step) {
      if (opts.signal?.aborted) throw new Error('Отменено');
      await seek(v, Math.min(t, Math.max(0, (v.duration || to) - 0.05)));
      ctx.drawImage(v, 0, 0, cw, ch);
      let found = boxes(det.detect(canvas), b => ({ x: (b.originX + b.width / 2) / cw, y: (b.originY + b.height / 2) / ch, area: (b.width * b.height) / (cw * ch) }));
      if (!found.length && side > 0) {
        for (const off of [0, long / 2, long]) {
          const sx = vw >= vh ? off : 0, sy = vw >= vh ? 0 : off;
          tctx.drawImage(v, sx, sy, side, side, 0, 0, T, T);
          found.push(...boxes(det.detect(tile), b => ({
            x: (sx + ((b.originX + b.width / 2) / T) * side) / vw,
            y: (sy + ((b.originY + b.height / 2) / T) * side) / vh,
            area: ((b.width / T) * side * (b.height / T) * side) / (vw * vh),
          })));
        }
        // куски перекрываются: одно лицо могло найтись дважды
        found = found.filter((f, i) => !found.slice(0, i).some(g => Math.hypot(f.x - g.x, f.y - g.y) < 0.05));
      }
      // самое крупное лицо, а при равных — ближайшее к прошлому, чтобы камера не прыгала между людьми
      let best: { x: number; y: number; score: number } | null = null;
      for (const f of found) {
        const near: number = prev ? 1 - Math.min(1, Math.hypot(f.x - prev.x, f.y - prev.y) * 2) : 0.5;
        const score: number = f.area * 4 + near * 0.6;
        if (!best || score > best.score) best = { x: f.x, y: f.y, score };
      }
      if (best) prev = best;
      out.push({ t, x: best?.x ?? prev?.x ?? 0.5, y: best?.y ?? prev?.y ?? 0.5, found: !!best });
      opts.onProgress?.((t - from) / Math.max(0.01, to - from));
    }
  } finally {
    v.removeAttribute('src');
    v.load();
  }
  return out;
}

/**
 * Плавная камера: стоит на месте, пока лицо в середине кадра, и мягко догоняет, когда человек отходит.
 * Возвращает точки центра (доли исходника) по времени исходника.
 */
export function cameraPath(samples: FaceSample[], deadZone = 0.06): { t: number; x: number; y: number }[] {
  if (!samples.length) return [];
  // убираем случайные выбросы: медиана по пяти соседям
  const med = samples.map((s, i) => {
    const xs = samples.slice(Math.max(0, i - 2), i + 3).map(q => q.x).sort((a, b) => a - b);
    const ys = samples.slice(Math.max(0, i - 2), i + 3).map(q => q.y).sort((a, b) => a - b);
    return { t: s.t, x: xs[xs.length >> 1], y: ys[ys.length >> 1] };
  });
  const pts: { t: number; x: number; y: number }[] = [];
  let cam = { x: med[0].x, y: med[0].y };
  let target = { ...cam };
  for (const m of med) {
    if (Math.abs(m.x - cam.x) > deadZone) target.x = m.x;
    if (Math.abs(m.y - cam.y) > deadZone * 1.5) target.y = m.y;
    cam = { x: cam.x + (target.x - cam.x) * 0.35, y: cam.y + (target.y - cam.y) * 0.35 };
    pts.push({ t: m.t, x: cam.x, y: cam.y });
  }
  return simplifyPath(pts, 0.004);
}
