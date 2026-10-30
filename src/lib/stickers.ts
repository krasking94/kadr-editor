// Стикеры и фигуры: рисуем на холсте в PNG с прозрачным фоном, потом кладём поверх видео.

export const EMOJI = ['😀', '😂', '😍', '😎', '🤔', '😱', '🥳', '👍', '👎', '👏', '🙏', '💪', '🔥', '⭐', '✨', '❤️', '💯', '✅', '❌', '⚠️', '❓', '❗', '👉', '👇', '🎉', '🎁', '💰', '📌', '📣', '🚀', '⏰', '📍'];

export type ShapeKind = 'arrow' | 'circle' | 'rect' | 'underline' | 'star' | 'check' | 'cross' | 'bubble' | 'marker' | 'pointer';

export const SHAPES: { id: ShapeKind; label: string; w: number; h: number }[] = [
  { id: 'arrow', label: 'Стрелка', w: 900, h: 420 },
  { id: 'pointer', label: 'Изогнутая стрелка', w: 800, h: 640 },
  { id: 'circle', label: 'Обвести', w: 900, h: 600 },
  { id: 'rect', label: 'Рамка', w: 900, h: 600 },
  { id: 'underline', label: 'Подчеркнуть', w: 1000, h: 200 },
  { id: 'marker', label: 'Маркер', w: 1000, h: 220 },
  { id: 'star', label: 'Звезда', w: 640, h: 640 },
  { id: 'check', label: 'Галочка', w: 640, h: 560 },
  { id: 'cross', label: 'Крестик', w: 600, h: 600 },
  { id: 'bubble', label: 'Облачко', w: 900, h: 640 },
];

export const SHAPE_COLORS = ['#ff3b5c', '#ffd60a', '#3ddc97', '#2bd4c5', '#3a7bff', '#ffffff', '#111111'];

/** PNG фигуры (data URL). Толщина линий подобрана так, чтобы фигура читалась даже маленькой. */
export function renderShape(kind: ShapeKind, color: string): { dataUrl: string; w: number; h: number } {
  const def = SHAPES.find(s => s.id === kind)!;
  const W = def.w, H = def.h;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d')!;
  const lw = 34;
  g.strokeStyle = color; g.fillStyle = color; g.lineWidth = lw; g.lineCap = 'round'; g.lineJoin = 'round';
  g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = 18; g.shadowOffsetY = 6;
  const m = lw;
  switch (kind) {
    case 'arrow': {
      const y = H / 2;
      g.beginPath(); g.moveTo(m, y); g.lineTo(W - 190, y); g.stroke();
      g.beginPath(); g.moveTo(W - m, y); g.lineTo(W - 230, y - 150); g.lineTo(W - 230, y + 150); g.closePath(); g.fill();
      break;
    }
    case 'pointer': {
      g.beginPath(); g.moveTo(m * 2, H - m * 2); g.quadraticCurveTo(m * 2, m * 3, W - 230, m * 4); g.stroke();
      g.beginPath(); g.moveTo(W - m, m * 4); g.lineTo(W - 250, m * 4 - 130); g.lineTo(W - 250, m * 4 + 130); g.closePath(); g.fill();
      break;
    }
    case 'circle':
      g.beginPath(); g.ellipse(W / 2, H / 2, W / 2 - m, H / 2 - m, -0.05, 0, Math.PI * 2); g.stroke();
      break;
    case 'rect':
      g.beginPath(); g.roundRect(m, m, W - 2 * m, H - 2 * m, 40); g.stroke();
      break;
    case 'underline':
      g.beginPath(); g.moveTo(m, H * 0.55); g.bezierCurveTo(W * 0.3, H * 0.25, W * 0.65, H * 0.85, W - m, H * 0.45); g.stroke();
      break;
    case 'marker':
      g.shadowColor = 'transparent';
      g.globalAlpha = 0.45; g.lineWidth = H * 0.6;
      g.beginPath(); g.moveTo(H * 0.35, H / 2); g.lineTo(W - H * 0.35, H / 2); g.stroke();
      break;
    case 'star': {
      g.beginPath();
      for (let i = 0; i < 10; i++) {
        const r = i % 2 ? W * 0.2 : W / 2 - m, a = -Math.PI / 2 + (i * Math.PI) / 5;
        const x = W / 2 + r * Math.cos(a), y = H / 2 + 20 + r * Math.sin(a);
        if (i) g.lineTo(x, y); else g.moveTo(x, y);
      }
      g.closePath(); g.fill();
      break;
    }
    case 'check':
      g.lineWidth = lw * 2.2;
      g.beginPath(); g.moveTo(m * 2, H * 0.55); g.lineTo(W * 0.4, H - m * 2.5); g.lineTo(W - m * 2, m * 2.5); g.stroke();
      break;
    case 'cross':
      g.lineWidth = lw * 2.2;
      g.beginPath(); g.moveTo(m * 2.5, m * 2.5); g.lineTo(W - m * 2.5, H - m * 2.5); g.moveTo(W - m * 2.5, m * 2.5); g.lineTo(m * 2.5, H - m * 2.5); g.stroke();
      break;
    case 'bubble': {
      g.beginPath(); g.roundRect(m, m, W - 2 * m, H * 0.72, 90); g.fill();
      g.beginPath(); g.moveTo(W * 0.22, H * 0.7); g.lineTo(W * 0.16, H - m); g.lineTo(W * 0.42, H * 0.7); g.closePath(); g.fill();
      break;
    }
  }
  return { dataUrl: cv.toDataURL('image/png'), w: W, h: H };
}
