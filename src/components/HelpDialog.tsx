// Справка (с 1.0): поиск по статьям простым языком и кнопка, которая сразу открывает нужное место программы.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Bug, LifeBuoy, Search, Sparkles } from 'lucide-react';
import { api } from '../api';
import { HELP, searchHelp, type HelpAction, type HelpArticle } from '../lib/help';
import { get, set, useStore } from '../state/store';
import { startTour } from './Tour';
import { Modal } from './ui';

/** Нужен ли для кнопки открытый проект (на стартовом экране вкладок и окон монтажа ещё нет) */
const needsProject = (a: HelpAction) => a.kind === 'rail' || a.kind === 'tour' || (a.kind === 'dialog' && a.dialog !== 'shortcuts');

function run(a: HelpAction) {
  if (a.kind === 'settings') { set({ dialog: 'settings', settingsTab: a.tab }); return; }
  if (a.kind === 'dialog') { set({ dialog: a.dialog }); return; }
  set({ dialog: null });
  if (a.kind === 'tour') { setTimeout(startTour, 150); return; }
  // Боковая панель живёт в редакторе: он слушает это событие и открывает нужную вкладку
  window.dispatchEvent(new CustomEvent('hl:rail', { detail: a.tab }));
}

/** Абзац статьи: «1. …» — шаг с номером в кружке, остальное — обычный текст */
function Paragraph({ text }: { text: string }) {
  const m = /^(\d+)\.\s+(.*)$/s.exec(text);
  if (!m) return <p>{text}</p>;
  return <div className="help-step"><span>{m[1]}</span><p>{m[2]}</p></div>;
}

export function HelpDialog() {
  const project = useStore(s => s.project);
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState<string>(() => get().helpArticle || HELP[0].id);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => () => set({ helpArticle: undefined }), []);

  const found = useMemo(() => searchHelp(query), [query]);
  // при поиске сразу показываем самую подходящую статью
  useEffect(() => { if (query.trim() && found.length) setCurrent(found[0].id); }, [found]);
  const article: HelpArticle | undefined = HELP.find(a => a.id === current);
  const groups = [...new Set(HELP.map(a => a.group))];

  const move = (d: number) => {
    const i = found.findIndex(a => a.id === current);
    const next = found[Math.max(0, Math.min(found.length - 1, (i < 0 ? -1 : i) + d))];
    if (!next) return;
    setCurrent(next.id);
    listRef.current?.querySelector(`[data-id="${next.id}"]`)?.scrollIntoView({ block: 'nearest' });
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter' && article?.action && (project || !needsProject(article.action))) { e.preventDefault(); run(article.action); }
  };

  const item = (a: HelpArticle) => (
    <button key={a.id} data-id={a.id} className={'help-item' + (a.id === current ? ' on' : '')} onClick={() => setCurrent(a.id)}>{a.title}</button>
  );

  return (
    <Modal title="Справка" icon={<LifeBuoy size={18} />} width={940} className="help-modal" onClose={() => set({ dialog: null })}>
      <div className="help-layout">
        <div className="help-nav">
          <div className="help-search">
            <Search size={15} />
            <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={onKey} placeholder="Что вы хотите сделать?" spellCheck={false} />
          </div>
          <div className="help-list" ref={listRef}>
            {query.trim()
              ? (found.length ? found.map(item) : <div className="small-text muted" style={{ padding: '10px 8px' }}>Ничего не нашлось. Попробуйте другое слово — например, «звук», «текст» или «сохранить».</div>)
              : groups.map(g => (
                <div key={g}>
                  <div className="help-group">{g}</div>
                  {HELP.filter(a => a.group === g).map(item)}
                </div>
              ))}
          </div>
        </div>
        <div className="help-article">
          {article && (
            <>
              <div className="help-crumb">{article.group}</div>
              <h3>{article.title}</h3>
              {article.body.map((t, i) => <Paragraph key={i} text={t} />)}
              {article.action && (
                project || !needsProject(article.action)
                  ? <button className="btn primary" style={{ alignSelf: 'flex-start', marginTop: 6 }} onClick={() => run(article.action!)}>{article.action.label} <ArrowRight size={14} /></button>
                  : <div className="small-text muted" style={{ marginTop: 6 }}>Кнопка «{article.action.label}» появится, когда вы создадите или откроете проект.</div>
              )}
            </>
          )}
          <div className="help-more">
            <span className="small-text muted">Не нашли ответ?</span>
            {project && <button className="btn small ghost" onClick={() => set({ dialog: null, assistantOpen: true })}><Sparkles size={13} color="var(--accent)" /> Спросить ИИ-помощника</button>}
            <button className="btn small ghost" onClick={() => api.openExternal('https://github.com/krasking94/kadr-editor/issues/new')}><Bug size={13} /> Написать разработчику</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
