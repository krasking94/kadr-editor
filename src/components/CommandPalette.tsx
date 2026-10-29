// Палитра команд (Ctrl+K): найти любое действие по названию, не помня, где оно в меню.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, Sparkles } from 'lucide-react';
import { COMMANDS, prettyKeys, type Command } from '../lib/commands';
import { get, set } from '../state/store';
import { askAssistant } from '../state/assistant';
import { Kbd } from './ui';

// Простое нечёткое сравнение: все буквы запроса встречаются по порядку
function score(label: string, q: string): number {
  const l = label.toLowerCase();
  if (!q) return 1;
  if (l.includes(q)) return 100 - l.indexOf(q);
  let i = 0;
  for (const ch of l) if (ch === q[i]) i++;
  return i === q.length ? 10 : 0;
}

export function CommandPalette() {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const hasProject = !!get().project && get().screen === 'editor';
  const items = useMemo(() => {
    const query = q.trim().toLowerCase();
    const list: (Command & { s: number })[] = COMMANDS
      .filter(c => !c.needsProject || hasProject)
      .map(c => ({ ...c, s: Math.max(score(c.label, query), score(c.group, query) / 2) }))
      .filter(c => c.s > 0)
      .sort((a, b) => b.s - a.s);
    if (query && hasProject) list.push({ id: 'ask', label: `Попросить ИИ: «${q.trim()}»`, group: 'ИИ', s: 0, run: () => askAssistant(q.trim()) });
    return list;
  }, [q, hasProject]);
  const close = () => set({ dialog: null });
  const run = (c: Command) => { close(); setTimeout(() => c.run(), 0); };

  useEffect(() => { setIdx(0); }, [q]);
  useEffect(() => { listRef.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' }); }, [idx]);

  return createPortal(
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal palette">
        <div className="row" style={{ paddingLeft: 16 }}>
          <Search size={18} color="var(--muted)" />
          <input autoFocus value={q} placeholder="Что сделать? Например: разрезать, субтитры, тема…" onChange={e => setQ(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(items.length - 1, i + 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(0, i - 1)); }
              if (e.key === 'Enter' && items[idx]) run(items[idx]);
              if (e.key === 'Escape') close();
            }} />
        </div>
        <div className="palette-list" ref={listRef}>
          {items.map((c, i) => (
            <div key={c.id} className={'palette-item' + (i === idx ? ' on' : '')} onMouseEnter={() => setIdx(i)} onClick={() => run(c)}>
              {c.id === 'ask' && <Sparkles size={15} color="var(--accent)" />}
              <span>{c.label}</span>
              <span className="grp">{c.group}</span>
              {c.keys && <Kbd>{prettyKeys(c.keys[0])}</Kbd>}
            </div>
          ))}
          {!items.length && <div className="empty-hint">Ничего не нашлось. Попробуйте другое слово.</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
