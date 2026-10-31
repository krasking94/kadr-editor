// Обложка для ролика: кадр + крупный текст. Рисуется на холсте — и в окне «Обложка», и по просьбе ИИ.
import { api } from '../api';
import { defaultBrand } from '../../shared/settings';
import { renderFrame } from '../state/actions';
import { get } from '../state/store';
import { loadFonts } from './fonts';

export type CoverLayout = 'bottom' | 'center' | 'left' | 'top';
type Layout = CoverLayout;

/** Разбить текст на строки, чтобы каждая влезла в ширину */
function wrap(ctx: CanvasRenderingContext2D, text: string, max: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const w of para.split(/\s+/).filter(Boolean)) {
      const next = line ? line + ' ' + w : w;
      if (ctx.measureText(next).width > max && line) { out.push(line); line = w; } else line = next;
    }
    out.push(line);
  }
  return out;
}

export function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement | null, W: number, H: number,
  o: { title: string; sub: string; layout: Layout; color: string; stroke: string; accent: string; font: string; pop: number; zoom: number }) {
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, W, H);
  if (img) {
    // картинка заполняет обложку; для «слева» — сдвинута вправо и чуть крупнее
    const k = Math.max(W / img.naturalWidth, H / img.naturalHeight) * o.zoom;
    const dw = img.naturalWidth * k, dh = img.naturalHeight * k;
    const dx = o.layout === 'left' ? W - dw + (dw - W) * 0.15 : (W - dw) / 2;
    ctx.filter = `saturate(${1 + o.pop * 0.5}) contrast(${1 + o.pop * 0.18}) brightness(${1 + o.pop * 0.06})`;
    ctx.drawImage(img, dx, (H - dh) / 2, dw, dh);
    ctx.filter = 'none';
  }
  // затемнение под текстом, чтобы его было видно на любом кадре
  const g = o.layout === 'left' ? ctx.createLinearGradient(0, 0, W * 0.75, 0)
    : o.layout === 'top' ? ctx.createLinearGradient(0, 0, 0, H * 0.6)
      : o.layout === 'bottom' ? ctx.createLinearGradient(0, H, 0, H * 0.35) : null;
  if (g) {
    g.addColorStop(0, 'rgba(0,0,0,.78)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  } else {
    ctx.fillStyle = 'rgba(0,0,0,.22)';
    ctx.fillRect(0, 0, W, H);
  }
  const short = Math.min(W, H);
  const maxW = o.layout === 'left' ? W * 0.55 : W * 0.88;
  let size = short * (o.layout === 'center' ? 0.2 : 0.16);
  const title = o.title.toUpperCase();
  let lines: string[] = [];
  // уменьшаем шрифт, пока текст не влезет в 3 строки
  for (let i = 0; i < 12; i++) {
    ctx.font = `900 ${size}px "${o.font}", "Montserrat", sans-serif`;
    lines = wrap(ctx, title, maxW);
    if (lines.length <= 3 && lines.every(l => ctx.measureText(l).width <= maxW)) break;
    size *= 0.88;
  }
  const lh = size * 1.05;
  const subSize = size * 0.42;
  const block = lines.length * lh + (o.sub ? subSize * 1.6 : 0);
  const left = o.layout === 'left';
  const x = left ? W * 0.06 : W / 2;
  let y = o.layout === 'top' ? short * 0.07 : o.layout === 'bottom' ? H - short * 0.07 - block : (H - block) / 2;
  ctx.textAlign = left ? 'left' : 'center';
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  for (const l of lines) {
    ctx.font = `900 ${size}px "${o.font}", "Montserrat", sans-serif`;
    ctx.shadowColor = 'rgba(0,0,0,.55)';
    ctx.shadowBlur = size * 0.12;
    ctx.shadowOffsetY = size * 0.05;
    ctx.lineWidth = size * 0.14;
    ctx.strokeStyle = o.stroke;
    ctx.strokeText(l, x, y);
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = o.color;
    ctx.fillText(l, x, y);
    y += lh;
  }
  if (o.sub) {
    y += subSize * 0.4;
    ctx.font = `700 ${subSize}px "${o.font}", "Montserrat", sans-serif`;
    const w = ctx.measureText(o.sub).width + subSize * 0.8;
    const bx = left ? x : x - w / 2;
    ctx.fillStyle = o.accent;
    ctx.fillRect(bx, y - subSize * 0.12, w, subSize * 1.3);
    ctx.fillStyle = '#111318';
    ctx.fillText(o.sub, left ? x + subSize * 0.4 : x, y);
  }
}


/** Обложка без окна (для ИИ): кадр в момент time, сохраняется в «Документы/Хлопушка/Картинки» */
export async function makeCover(o: { time?: number; title: string; sub?: string; layout?: Layout; color?: string }): Promise<string> {
  const s = get();
  const p = s.project!;
  const tall = p.height > p.width;
  const W = tall ? 1080 : 1280, H = tall ? 1920 : 720;
  await loadFonts();
  const img = new Image();
  img.src = 'data:image/jpeg;base64,' + (await renderFrame(o.time ?? s.playhead, W));
  await img.decode();
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const b = { ...defaultBrand(), ...s.settings.brand };
  drawCover(cv.getContext('2d')!, img, W, H, { title: o.title, sub: o.sub || '', layout: o.layout || 'bottom', color: o.color || '#ffe14d', stroke: '#000000', accent: b.accent, font: b.font, pop: 0.5, zoom: 1 });
  return api.saveImage(cv.toDataURL('image/png'), `${p.name} — обложка ${Date.now() % 100000}`);
}
