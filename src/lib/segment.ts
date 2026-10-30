// Где человек в кадре: нейросеть MediaPipe (Selfie Segmenter) прямо на компьютере, без интернета.
import { assetUrl } from './face-track';

type Mask = { getAsFloat32Array: () => Float32Array; close: () => void };
type Segmenter = { segment: (img: HTMLCanvasElement) => { confidenceMasks?: Mask[]; close?: () => void }; close: () => void };

let segPromise: Promise<Segmenter> | null = null;

export function personSegmenter(): Promise<Segmenter> {
  if (!segPromise) {
    segPromise = (async () => {
      const vision = await import('@mediapipe/tasks-vision');
      const fileset = { wasmLoaderPath: assetUrl('mediapipe/vision_wasm_internal.js'), wasmBinaryPath: assetUrl('mediapipe/vision_wasm_internal.wasm') };
      return (await vision.ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: assetUrl('models/selfie_segmenter.tflite'), delegate: 'CPU' },
        runningMode: 'IMAGE', outputConfidenceMasks: true, outputCategoryMask: false,
      })) as unknown as Segmenter;
    })();
    segPromise.catch(() => { segPromise = null; });
  }
  return segPromise;
}

/**
 * Маски человека для кадров RGBA (w×h подряд). prev — маска прошлого кадра:
 * смешиваем с ней, чтобы край не дрожал от кадра к кадру.
 */
export async function personMasks(rgba: Uint8Array, w: number, h: number, prev: Float32Array | null): Promise<{ masks: Uint8Array; last: Float32Array | null }> {
  const seg = await personSegmenter();
  const size = w * h;
  const n = Math.floor(rgba.length / (size * 4));
  const out = new Uint8Array(n * size);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  let last = prev;
  for (let f = 0; f < n; f++) {
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset + f * size * 4, size * 4), w, h), 0, 0);
    const res = seg.segment(canvas);
    const m = res.confidenceMasks?.[0];
    const conf = m ? m.getAsFloat32Array() : new Float32Array(size);
    const cur = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      const v = conf[i] ?? 0;
      cur[i] = last ? v * 0.7 + last[i] * 0.3 : v;
      out[f * size + i] = Math.round(Math.max(0, Math.min(1, cur[i])) * 255);
    }
    last = cur;
    res.confidenceMasks?.forEach(x => x.close());
    res.close?.();
  }
  return { masks: out, last };
}
