// Как выглядит переход в просмотре (приближённо к тому, что сделает FFmpeg при экспорте).
// p — прогресс перехода от 0 до 1, incoming — новый клип (иначе уходящий).
export interface TransitionFx { opacity: number; dx: number; dy: number; scale: number; clip?: string; mask?: string }
export const NO_FX: TransitionFx = { opacity: 1, dx: 0, dy: 0, scale: 1 };

export function transitionFx(type: string, p: number, incoming: boolean, W: number, H: number): TransitionFx {
  const q = 1 - p;
  if (!incoming) {
    switch (type) {
      case 'fadeblack': case 'fadewhite': return { ...NO_FX, opacity: Math.max(0, 1 - 2 * p) };
      case 'slideleft': return { ...NO_FX, dx: -p * W };
      case 'slideright': return { ...NO_FX, dx: p * W };
      case 'slideup': return { ...NO_FX, dy: -p * H };
      case 'slidedown': return { ...NO_FX, dy: p * H };
      case 'circleclose': return { ...NO_FX, clip: `circle(${q * 75}% at 50% 50%)` };
      default: return NO_FX;
    }
  }
  switch (type) {
    case 'fadeblack': case 'fadewhite': return { ...NO_FX, opacity: Math.max(0, 2 * p - 1) };
    case 'wipeleft': return { ...NO_FX, clip: `inset(0 0 0 ${q * 100}%)` };
    case 'wiperight': return { ...NO_FX, clip: `inset(0 ${q * 100}% 0 0)` };
    case 'wipeup': return { ...NO_FX, clip: `inset(${q * 100}% 0 0 0)` };
    case 'wipedown': return { ...NO_FX, clip: `inset(0 0 ${q * 100}% 0)` };
    case 'slideleft': return { ...NO_FX, dx: q * W };
    case 'slideright': return { ...NO_FX, dx: -q * W };
    case 'slideup': return { ...NO_FX, dy: q * H };
    case 'slidedown': return { ...NO_FX, dy: -q * H };
    case 'circleopen': return { ...NO_FX, clip: `circle(${p * 75}% at 50% 50%)` };
    case 'circleclose': return { ...NO_FX, opacity: 1 };
    case 'zoomin': return { ...NO_FX, opacity: p, scale: 0.6 + 0.4 * p };
    case 'smoothleft': return { ...NO_FX, mask: `linear-gradient(to left, #000 ${p * 120 - 20}%, transparent ${p * 120}%)` };
    case 'smoothright': return { ...NO_FX, mask: `linear-gradient(to right, #000 ${p * 120 - 20}%, transparent ${p * 120}%)` };
    case 'radial': return { ...NO_FX, mask: `conic-gradient(from 0deg, #000 ${p * 360}deg, transparent ${p * 360}deg)` };
    default: return { ...NO_FX, opacity: p };
  }
}

