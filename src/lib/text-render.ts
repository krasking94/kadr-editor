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

// Какое слово звучит в момент local (от начала клипа); -1 — пока ни одно
export function activeWord(c: TextClip, local: number): number {
  if (!c.words?.length || !c.highlight) return -1;
  let idx = -1;
  for (let i = 0; i < c.words.length; i++) if (local >= c.words[i].s - 0.02) idx = i;
  return idx;
}

/**
 * Рисует текст на холсте размером W×H (весь кадр). Возвращает рамку текста для выделения в просмотре.
 * active — номер произносимого слова для субтитров «слово за словом» (оно рисуется цветом подсветки).
 */
export function drawText(ctx: CanvasRenderingContext2D, c: TextClip, W: number, H: number, active = -1): { x: number; y: number; w: number; h: number } {
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
  let wordNo = 0;
  lines.forEach((line, i) => {
    const y = cy - bh / 2 + lh * (i + 0.5);
    const lineWords = line.split(/\s+/).filter(Boolean);
    const first = wordNo;
    wordNo += lineWords.length;
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
    // подсветка произносимого слова поверх строки
    if (active >= first && active < wordNo && c.highlight) {
      const k2 = active - first;
      const lw = widths[i];
      const lineLeft = s.align === 'left' ? left : s.align === 'right' ? left - lw : left - lw / 2;
      const before = lineWords.slice(0, k2).join(' ');
      const x = lineLeft + (before ? ctx.measureText(before + ' ').width : 0);
      ctx.save();
      ctx.textAlign = 'left';
      if (s.strokeWidth > 0) { ctx.lineJoin = 'round'; ctx.lineWidth = s.strokeWidth * 2 * k; ctx.strokeStyle = s.strokeColor; ctx.strokeText(lineWords[k2], x, y); }
      ctx.fillStyle = c.highlight;
      ctx.fillText(lineWords[k2], x, y);
      ctx.restore();
    }
  });
  ctx.restore();
  const extra = s.background ? pad : 0;
  return { x: cx - bw / 2 - extra, y: cy - bh / 2 - extra, w: bw + extra * 2, h: bh + extra * 2 };
}

/** PNG всего кадра с текстом — для экспорта */
export function renderTextPng(c: TextClip, W: number, H: number, active = -1): string {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  drawText(canvas.getContext('2d')!, c, W, H, active);
  return canvas.toDataURL('image/png');
}

/** Картинки для экспорта: для «слово за словом» — по одной на каждое слово, с временем показа */
export function renderTextPngs(c: TextClip, W: number, H: number): { dataUrl: string; from?: number; to?: number }[] {
  if (!c.words?.length || !c.highlight) return [{ dataUrl: renderTextPng(c, W, H) }];
  const out: { dataUrl: string; from?: number; to?: number }[] = [];
  const first = Math.max(0, c.words[0].s);
  if (first > 0.03) out.push({ dataUrl: renderTextPng(c, W, H, -1), from: 0, to: first });
  c.words.forEach((w, i) => {
    const from = Math.max(0, i === 0 ? first : w.s);
    const to = i + 1 < c.words!.length ? Math.max(from, c.words![i + 1].s) : c.duration;
    if (to - from > 0.005) out.push({ dataUrl: renderTextPng(c, W, H, i), from, to: Math.min(c.duration, to) });
  });
  return out;
}
