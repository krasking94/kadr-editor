// Верхняя полоса окна: меню, название проекта, отмена/возврат, ИИ и кнопка «Сохранить видео».
import { useEffect, useState } from 'react';
import { Command as CmdIcon, Download, History, Redo2, Sparkles, Undo2 } from 'lucide-react';
import { api } from '../api';
import { COMMANDS, prettyKeys, type Command } from '../lib/commands';
import { commit, redo, set, sourceLabel, undo, useStore } from '../state/store';
import { openMenu, type MenuItem } from './ui';
import { Logo } from './Logo';

const MENUS: { label: string; groups: Command['group'][] }[] = [
  { label: 'Файл', groups: ['Файл'] },
  { label: 'Правка', groups: ['Правка', 'Клип'] },
  { label: 'Вид', groups: ['Просмотр', 'Таймлайн'] },
  { label: 'ИИ', groups: ['ИИ'] },
  { label: 'Помощь', groups: ['Окно', 'Помощь'] },
];

function menuItems(groups: Command['group'][]): MenuItem[] {
  const out: MenuItem[] = [];
  groups.forEach((g, i) => {
    if (i) out.push({ separator: true });
    for (const c of COMMANDS.filter(x => x.group === g)) out.push({ label: c.label, shortcut: prettyKeys(c.keys?.[0]), onClick: c.run });
  });
  return out;
}

export function TitleBar() {
  const project = useStore(s => s.project)!;
  const dirty = useStore(s => s.dirty);
  const savedPath = useStore(s => s.savedPath);
  const past = useStore(s => s.past);
  const future = useStore(s => s.future);
  const assistantOpen = useStore(s => s.assistantOpen);
  const historyOpen = useStore(s => s.historyOpen);
  const [name, setName] = useState(project.name);
  useEffect(() => setName(project.name), [project.name]);

  const rename = () => {
    const n = name.trim() || 'Без названия';
    if (n !== project.name) { commit('Проект переименован', p => { p.name = n; }); api.setTitle(`${n} — Хлопушка`); }
    setName(n);
  };
  const lastPast = past[past.length - 1];

  return (
    <div className="titlebar">
      <div className="logo"><Logo /> Хлопушка</div>
      {MENUS.map(m => (
        <button key={m.label} className="menu-btn" onClick={e => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); openMenu(menuItems(m.groups), r.left, r.bottom + 4); }}>{m.label}</button>
      ))}
      <div style={{ width: 10 }} />
      <div className="project-name" data-tip={dirty ? 'Есть несохранённые изменения\nCtrl+S — сохранить' : savedPath ? 'Сохранено: ' + savedPath : 'Проект ещё не сохранён в файл'}>
        <span className={'save-dot' + (dirty || !savedPath ? ' dirty' : '')} />
        <input value={name} onChange={e => setName(e.target.value)} onBlur={rename} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} size={Math.max(6, name.length)} />
      </div>
      <button className="icon-btn" disabled={!past.length} onClick={undo}
        data-tip={lastPast ? `Отменить: ${lastPast.label}${lastPast.source !== 'user' ? ` (${sourceLabel(lastPast.source)})` : ''}\nCtrl+Z` : 'Отменять нечего'}><Undo2 size={17} /></button>
      <button className="icon-btn" disabled={!future.length} onClick={redo}
        data-tip={future[0] ? `Вернуть: ${future[0].label}\nCtrl+Y` : 'Возвращать нечего'}><Redo2 size={17} /></button>
      <button className={'icon-btn' + (historyOpen ? ' active' : '')} onClick={() => set(s => ({ historyOpen: !s.historyOpen }))} data-tip={'История шагов\nCtrl+H'}><History size={17} /></button>
      <div className="drag" />
      <button className="btn ghost small" onClick={() => set({ dialog: 'palette' })} data-tip="Найти любую команду">
        <CmdIcon size={14} /> Команды <kbd>Ctrl K</kbd>
      </button>
      <button className={'btn small' + (assistantOpen ? ' active' : '')} onClick={() => set(s => ({ assistantOpen: !s.assistantOpen }))} data-tip={'Помощник монтирует по вашей просьбе\nCtrl+J'}>
        <Sparkles size={14} color="var(--accent)" /> ИИ-помощник
      </button>
      <button className="btn primary small" onClick={() => set({ dialog: 'export' })} data-tip={'Сохранить готовое видео\nCtrl+E'}>
        <Download size={14} /> Сохранить видео
      </button>
    </div>
  );
}
