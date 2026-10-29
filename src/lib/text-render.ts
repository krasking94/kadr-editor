// Рисует текстовый клип на холсте. Один и тот же код используется в просмотре и при экспорте,
// поэтому титры в готовом видео выглядят точно так же, как в окне программы.
import type { TextClip } from '../../shared/types';

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); continue; }
    let line = words[0];
    for (const w of words.slice(1)) {
      const test = line + ' ' + w;
      if (ctx.measureText(test).width > maxWidth) { out.push(line); line = w; } else line = test;
    }
    out.push(line);
  }
  return out;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function hexToRgba(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Рисует текст на холсте размером W×H (весь кадр). Возвращает рамку текста для выделения в просмотре. */
export function drawText(ctx: CanvasRenderingContext2D, c: TextClip, W: number, H: number): { x: number; y: number; w: number; h: number } {
  const s = c.style;
  const k = H / 1080;
  const size = (s.size / 1000) * H;
  ctx.save();
  ctx.font = `${s.italic ? 'italic ' : ''}${s.bold ? 700 : 400} ${size}px "${s.font}", Onest, sans-serif`;
  ctx.textBaseline = 'middle';
  const text = s.uppercase ? c.text.toUpperCase() : c.text;
  const lines = wrap(ctx, text, s.maxWidth * W);
  const lh = size * s.lineHeight;
  const widths = lines.map(l => ctx.measureText(l).width);
  const bw = Math.max(1, ...widths);
  const bh = lines.length * lh;
  const cx = s.x * W, cy = s.y * H;
  const left = s.align === 'left' ? cx - bw / 2 : s.align === 'right' ? cx + bw / 2 : cx;
  ctx.textAlign = s.align;
  const pad = size * 0.35;
  if (s.background) {
    ctx.fillStyle = hexToRgba(s.backgroundColor, s.backgroundOpacity);
    roundRect(ctx, cx - bw / 2 - pad, cy - bh / 2 - pad * 0.7, bw + pad * 2, bh + pad * 1.4, size * 0.22);
    ctx.fill();
  }
  lines.forEach((line, i) => {
    const y = cy - bh / 2 + lh * (i + 0.5);
    if (s.shadow) {
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = size * 0.18;
      ctx.shadowOffsetY = size * 0.05;
    }
    if (s.strokeWidth > 0) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = s.strokeWidth * 2 * k;
      ctx.strokeStyle = s.strokeColor;
      ctx.strokeText(line, left, y);
      ctx.shadowColor = 'transparent';
    }
    ctx.fillStyle = s.color;
    ctx.fillText(line, left, y);
    ctx.shadowColor = 'transparent';
  });
  ctx.restore();
  const extra = s.background ? pad : 0;
  return { x: cx - bw / 2 - extra, y: cy - bh / 2 - extra, w: bw + extra * 2, h: bh + extra * 2 };
}

/** PNG всего кадра с текстом — для экспорта */
export function renderTextPng(c: TextClip, W: number, H: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  drawText(canvas.getContext('2d')!, c, W, H);
  return canvas.toDataURL('image/png');
}
