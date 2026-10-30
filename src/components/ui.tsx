// Небольшие элементы интерфейса, из которых собраны панели.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { RotateCcw, X } from 'lucide-react';

export function Slider(p: {
  label: string; value: number; min: number; max: number; step?: number; def?: number; unit?: string;
  onChange: (v: number) => void; format?: (v: number) => string; hint?: string;
}) {
  const step = p.step ?? 0.01;
  const fill = ((p.value - p.min) / (p.max - p.min)) * 100;
  const [text, setText] = useState<string | null>(null);
  const shown = p.format ? p.format(p.value) : (Math.round(p.value * 100) / 100).toString();
  return (
    <div className="slider">
      <div className="slider-head">
        <span data-tip={p.hint} data-tip-pos="right">{p.label}</span>
        {p.def !== undefined && Math.abs(p.value - p.def) > 1e-6 && (
          <button className="icon-btn small reset" data-tip="Сбросить" onClick={() => p.onChange(p.def!)}><RotateCcw size={12} /></button>
        )}
      </div>
      <div className="slider-row">
        <input
          type="range" min={p.min} max={p.max} step={step} value={p.value} style={{ ['--fill' as string]: `${fill}%` }}
          onChange={e => p.onChange(Number(e.target.value))}
          onDoubleClick={() => p.def !== undefined && p.onChange(p.def)}
        />
        <input
          className="input num-input" value={text ?? shown + (p.unit || '')}
          onFocus={e => { setText(shown); setTimeout(() => e.target.select()); }}
          onChange={e => setText(e.target.value)}
          onBlur={() => {
            const v = parseFloat((text || '').replace(',', '.'));
            if (!isNaN(v)) p.onChange(Math.max(p.min, Math.min(p.max, v)));
            setText(null);
          }}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setText(null); (e.target as HTMLInputElement).blur(); } }}
        />
      </div>
    </div>
  );
}

export function Switch(p: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; hint?: string }) {
  return (
    <label className="row" style={{ cursor: 'pointer', justifyContent: 'space-between' }} data-tip={p.hint} data-tip-pos="top">
      {p.label && <span style={{ color: 'var(--text-2)', fontSize: 12.5 }}>{p.label}</span>}
      <span className="switch">
        <input type="checkbox" checked={p.checked} onChange={e => p.onChange(e.target.checked)} />
        <span />
      </span>
    </label>
  );
}

export function Segmented<T extends string>(p: { value: T; options: { value: T; label: ReactNode; tip?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented">
      {p.options.map(o => (
        <button key={o.value} className={o.value === p.value ? 'on' : ''} onClick={() => p.onChange(o.value)} data-tip={o.tip}>{o.label}</button>
      ))}
    </div>
  );
}

export function ColorInput(p: { value: string; onChange: (v: string) => void; label?: string }) {
  return (
    <div className="row" style={{ justifyContent: 'space-between' }}>
      {p.label && <span style={{ color: 'var(--text-2)', fontSize: 12.5 }}>{p.label}</span>}
      <div className="row">
        <span className="mono muted small-text">{p.value}</span>
        <label className="color-swatch" style={{ background: p.value }}>
          <input type="color" value={p.value} onChange={e => p.onChange(e.target.value)} />
        </label>
      </div>
    </div>
  );
}

export function Modal(p: { title: ReactNode; icon?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number; className?: string }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); p.onClose(); } };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [p.onClose]);
  return createPortal(
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) p.onClose(); }}>
      <div className={'modal ' + (p.className || '')} style={p.width ? { width: `min(${p.width}px, calc(100vw - 40px))` } : undefined}>
        <div className="modal-head">
          {p.icon}
          <h2>{p.title}</h2>
          <button className="icon-btn" onClick={p.onClose} data-tip="Закрыть (Esc)"><X size={16} /></button>
        </div>
        <div className="modal-body">{p.children}</div>
        {p.footer && <div className="modal-foot">{p.footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ── Всплывающее меню (и контекстное меню по правой кнопке) ──
export interface MenuItem {
  label?: string;
  icon?: ReactNode;
  shortcut?: string;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
  header?: string;
}

let openMenuFn: ((items: MenuItem[], x: number, y: number) => void) | null = null;
export function openMenu(items: MenuItem[], x: number, y: number) {
  openMenuFn?.(items, x, y);
}

export function MenuHost() {
  const [menu, setMenu] = useState<{ items: MenuItem[]; x: number; y: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    openMenuFn = (items, x, y) => setMenu({ items, x, y });
    return () => { openMenuFn = null; };
  }, []);
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => { if (!ref.current?.contains(e.target as Node)) setMenu(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    window.addEventListener('mousedown', close, true);
    window.addEventListener('keydown', esc, true);
    window.addEventListener('blur', () => setMenu(null));
    return () => { window.removeEventListener('mousedown', close, true); window.removeEventListener('keydown', esc, true); };
  }, [menu]);
  useEffect(() => {
    // не даём меню уйти за край окна
    const el = ref.current;
    if (!el || !menu) return;
    const r = el.getBoundingClientRect();
    let { x, y } = menu;
    if (r.right > window.innerWidth - 8) x = window.innerWidth - r.width - 8;
    if (r.bottom > window.innerHeight - 8) y = Math.max(8, window.innerHeight - r.height - 8);
    if (x !== menu.x || y !== menu.y) setMenu({ ...menu, x, y });
  }, [menu]);
  if (!menu) return null;
  return createPortal(
    <div className="menu" ref={ref} style={{ left: menu.x, top: menu.y }} onContextMenu={e => e.preventDefault()}>
      {menu.items.map((it, i) => it.separator ? <div key={i} className="menu-sep" />
        : it.header ? <div key={i} className="menu-label">{it.header}</div>
        : (
          <div key={i} className={'menu-item' + (it.disabled ? ' disabled' : '') + (it.danger ? ' danger' : '')}
            onClick={() => { setMenu(null); it.onClick?.(); }}>
            <span style={{ width: 16, display: 'grid', placeItems: 'center' }}>{it.icon}</span>
            {it.label}
            {it.shortcut && <span className="sc">{it.shortcut}</span>}
          </div>
        ))}
    </div>,
    document.body,
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>;
}
