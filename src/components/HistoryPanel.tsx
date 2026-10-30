// История шагов: видно каждое действие (и кто его сделал — вы или ИИ), можно вернуться к любому.
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Bot, Circle, History, User, X } from 'lucide-react';
import { jumpToHistory, set, sourceLabel, useStore } from '../state/store';

const time = (t: number) => new Date(t).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function HistoryPanel() {
  const past = useStore(s => s.past);
  const future = useStore(s => s.future);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest('[data-tip^="История"]')) set({ historyOpen: false });
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, []);
  // past[i] хранит состояние ДО шага i; текущее состояние — после последнего шага в past
  const rows = [
    ...future.slice().reverse().map((h, i) => ({ h, idx: past.length + future.length - 1 - i, undone: true })),
    ...past.slice().reverse().map((h, i) => ({ h, idx: past.length - 1 - i, undone: false })),
  ];
  return createPortal(
    <div ref={ref} className="menu" style={{ right: 260, top: 48, width: 340, maxHeight: '70vh', overflow: 'auto', padding: 0 }}>
      <div className="panel-head" style={{ position: 'sticky', top: 0, background: 'var(--raised)', zIndex: 1 }}>
        <History size={15} /><h3>История шагов</h3>
        <span className="muted small-text">{past.length}</span>
        <button className="icon-btn small" onClick={() => set({ historyOpen: false })}><X size={14} /></button>
      </div>
      <div style={{ padding: 5 }}>
        {rows.map(({ h, idx, undone }) => (
          <div key={idx + ':' + h.at} className="menu-item" style={{ opacity: undone ? 0.45 : 1 }} onClick={() => jumpToHistory(idx)}
            data-tip={undone ? 'Отменённый шаг — нажмите, чтобы вернуть' : 'Вернуться к этому шагу'} data-tip-pos="left">
            {h.source === 'user' ? <User size={14} color="var(--muted)" /> : <Bot size={14} color="var(--accent)" />}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.label}</span>
            <span className="sc">{h.source !== 'user' ? sourceLabel(h.source) + ' · ' : ''}{time(h.at)}</span>
          </div>
        ))}
        <div className="menu-item" onClick={() => jumpToHistory(-1)} style={{ opacity: past.length ? 1 : 0.45 }}>
          <Circle size={14} color="var(--muted)" /> Начало (открытие проекта)
        </div>
        {!rows.length && <div className="empty-hint">Здесь появится каждое ваше действие. Любое можно отменить.</div>}
      </div>
    </div>,
    document.body,
  );
}
