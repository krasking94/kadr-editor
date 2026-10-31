// Подсказки при наведении. Любой элемент с атрибутом data-tip показывает подсказку поверх всего окна:
// она не прячется за соседними кнопками, не обрезается краем панели и не вылезает за край экрана.
// Сторону задаёт data-tip-pos (top, bottom, left, right); если места нет — подсказка встаёт с другой стороны.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type Pos = 'top' | 'bottom' | 'left' | 'right';
interface Tip { text: string; rect: DOMRect; pos: Pos }

const GAP = 8, EDGE = 6;
const OPPOSITE: Record<Pos, Pos> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

function place(rect: DOMRect, w: number, h: number, pos: Pos): { x: number; y: number } {
  const vw = window.innerWidth, vh = window.innerHeight;
  const fits = (p: Pos) =>
    p === 'bottom' ? rect.bottom + GAP + h <= vh - EDGE
      : p === 'top' ? rect.top - GAP - h >= EDGE
        : p === 'right' ? rect.right + GAP + w <= vw - EDGE
          : rect.left - GAP - w >= EDGE;
  const p = fits(pos) || !fits(OPPOSITE[pos]) ? pos : OPPOSITE[pos];
  let x: number, y: number;
  if (p === 'top' || p === 'bottom') {
    x = rect.left + rect.width / 2 - w / 2;
    y = p === 'bottom' ? rect.bottom + GAP : rect.top - GAP - h;
  } else {
    y = rect.top + rect.height / 2 - h / 2;
    x = p === 'right' ? rect.right + GAP : rect.left - GAP - w;
  }
  x = Math.max(EDGE, Math.min(x, vw - w - EDGE));
  y = Math.max(EDGE, Math.min(y, vh - h - EDGE));
  return { x, y };
}

export function TipHost() {
  const [tip, setTip] = useState<Tip | null>(null);
  const [xy, setXy] = useState<{ x: number; y: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cur: HTMLElement | null = null; // элемент под мышью
    let muted: HTMLElement | null = null; // по нему щёлкнули — до ухода мыши подсказку не показываем
    let timer = 0;
    let lastHide = 0;
    let watch: MutationObserver | null = null;

    const hide = () => {
      clearTimeout(timer);
      watch?.disconnect();
      watch = null;
      setTip(t => { if (t) lastHide = performance.now(); return null; });
    };
    const show = (el: HTMLElement) => {
      const text = el.getAttribute('data-tip');
      if (!text || !el.isConnected) return;
      setXy(null);
      setTip({ text, rect: el.getBoundingClientRect(), pos: (el.getAttribute('data-tip-pos') as Pos) || 'bottom' });
      // текст подсказки может поменяться, пока мышь на кнопке (например, «Пауза» ↔ «Играть»)
      watch = new MutationObserver(() => {
        const t = el.getAttribute('data-tip');
        if (!t || !el.isConnected) hide();
        else setTip({ text: t, rect: el.getBoundingClientRect(), pos: (el.getAttribute('data-tip-pos') as Pos) || 'bottom' });
      });
      watch.observe(el, { attributes: true, attributeFilter: ['data-tip', 'data-tip-pos'] });
    };
    const over = (e: PointerEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.('[data-tip]') as HTMLElement | null;
      if (el === cur) return;
      cur = el;
      if (muted && muted !== el) muted = null;
      hide();
      if (!el || el === muted) return;
      // если подсказка только что была — следующая появляется сразу, как в обычных программах
      const quick = performance.now() - lastHide < 400;
      timer = window.setTimeout(() => { if (cur === el && e.buttons === 0) show(el); }, quick ? 60 : 450);
    };
    const leaveWindow = (e: PointerEvent) => { if (!e.relatedTarget) { cur = null; muted = null; hide(); } };
    const press = () => { muted = cur; hide(); };

    document.addEventListener('pointerover', over, true);
    document.addEventListener('pointerout', leaveWindow, true);
    window.addEventListener('pointerdown', press, true);
    window.addEventListener('wheel', press, { capture: true, passive: true });
    window.addEventListener('keydown', press, true);
    window.addEventListener('blur', hide);
    window.addEventListener('resize', hide);
    return () => {
      hide();
      document.removeEventListener('pointerover', over, true);
      document.removeEventListener('pointerout', leaveWindow, true);
      window.removeEventListener('pointerdown', press, true);
      window.removeEventListener('wheel', press, true);
      window.removeEventListener('keydown', press, true);
      window.removeEventListener('blur', hide);
      window.removeEventListener('resize', hide);
    };
  }, []);

  useLayoutEffect(() => {
    if (!tip || !box.current) return;
    const r = box.current.getBoundingClientRect();
    setXy(place(tip.rect, r.width, r.height, tip.pos));
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div ref={box} className="tip" role="tooltip"
      style={xy ? { left: xy.x, top: xy.y } : { left: 0, top: 0, visibility: 'hidden' }}>
      {tip.text}
    </div>,
    document.body,
  );
}
