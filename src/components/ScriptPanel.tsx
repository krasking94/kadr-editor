// Панели версии 0.3: «Речь» — монтаж через текст, «Shorts» — нарезка длинного видео на короткие ролики.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Scissors, Search, Play, Pause, X, ScrollText, Eraser, Timer, RefreshCw, Smartphone, Sparkles, Check, MapPin, Download, Loader2, TriangleAlert,
} from 'lucide-react';
import { findPauses, paragraphs, pauseCut, timelineWords, mediaNeedingTranscript, type TWord } from '../../shared/transcript';
import { formatTime, mainTrack } from '../../shared/timeline';
import { providerPreset } from '../../shared/providers';
import { get, set, toast, useStore } from '../state/store';
import { cutTimeline } from '../state/smart';
import * as SC from '../state/script';
import { openMenu, Segmented, Slider, Switch } from './ui';

// Проиграть кусок ролика и остановиться в конце
function playRange(start: number, end: number) {
  set({ playhead: start, playing: true });
  const unsub = useStore.subscribe(s => {
    if (!s.playing) { unsub(); return; }
    if (s.playhead >= end) { unsub(); set({ playing: false }); }
  });
}

function useSpeechReady() {
  const settings = useStore(s => s.settings);
  const secrets = useStore(s => s.secrets);
  const sp = providerPreset(settings.ai.speechProvider);
  // без ключа речь распознаётся нейросетью на компьютере, так что распознавать можно всегда
  const local = settings.ai.speechProvider === 'local' || (sp.needsKey && !secrets[sp.id]);
  return { ok: true, local, label: local ? 'на компьютере, без интернета' : sp.label };
}

function TranscribeCard({ text }: { text: string }) {
  const speech = useSpeechReady();
  const busy = useStore(s => s.tasks.find(t => t.label.startsWith('Распознаю речь')));
  return (
    <div className="card">
      <div className="small-text muted">{text}</div>
      <div className="small-text muted">Речь распознаётся {speech.local ? 'нейросетью на компьютере — без интернета и бесплатно' : `через ${speech.label}`}. <a style={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={() => set({ dialog: 'settings', settingsTab: 'ai' })}>Изменить</a></div>
      <button className="btn primary" disabled={!!busy} onClick={() => SC.ensureTranscripts()}>
        {busy ? <><Loader2 size={14} className="spin" /> {busy.label}{busy.progress ? ` · ${Math.round(busy.progress * 100)}%` : ''}</> : <><ScrollText size={14} /> Распознать речь</>}
      </button>
    </div>
  );
}

// ── Монтаж через текст ───────────────────────────────
export function ScriptPanel() {
  const project = useStore(s => s.project)!;
  const words = useMemo(() => timelineWords(project), [project]);
  const missing = useMemo(() => mediaNeedingTranscript(project), [project]);
  const paras = useMemo(() => paragraphs(words), [words]);
  const pauses = useMemo(() => findPauses(words, 0.7), [words]);
  const pauseAfter = useMemo(() => new Map(pauses.map(p => [p.after, p])), [pauses]);
  const fillers = useMemo(() => new Set(SC.fillerWords(words).map(w => w.i)), [words]);
  const [sel, setSel] = useState<{ a: number; b: number } | null>(null);
  const [pauseSel, setPauseSel] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const playing = useStore(s => s.playing);
  const boxRef = useRef<HTMLDivElement>(null);
  const drag = useRef<number | null>(null);
  const matches = useMemo(() => (query.trim() ? SC.findPhrase(words, query) : []), [words, query]);
  const matchSet = useMemo(() => { const s = new Set<number>(); for (const [a, b] of matches) for (let i = a; i <= b; i++) s.add(i); return s; }, [matches]);

  // выделение сбрасываем, когда текст поменялся (вырезали, отменили)
  useEffect(() => { setSel(null); setPauseSel(null); }, [words.length]);

  // подсветка слова, которое звучит сейчас, без перерисовки всего текста
  useEffect(() => {
    let cur: HTMLElement | null = null;
    const find = (t: number) => {
      let lo = 0, hi = words.length - 1, ans = -1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (words[mid].s <= t + 0.02) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
      return ans >= 0 && t <= words[ans].e + 0.25 ? ans : -1;
    };
    const apply = (t: number, follow: boolean) => {
      const i = find(t);
      const el = i >= 0 ? boxRef.current?.querySelector<HTMLElement>(`[data-i="${i}"]`) ?? null : null;
      if (el === cur) return;
      cur?.classList.remove('cur');
      el?.classList.add('cur');
      cur = el;
      if (el && follow) {
        const box = boxRef.current!.getBoundingClientRect(), r = el.getBoundingClientRect();
        if (r.top < box.top + 30 || r.bottom > box.bottom - 60) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    };
    apply(get().playhead, false);
    return useStore.subscribe((s, prev) => { if (s.playhead !== prev.playhead) apply(s.playhead, s.playing); });
  }, [words]);

  const range = sel ? { a: Math.min(sel.a, sel.b), b: Math.max(sel.a, sel.b) } : null;
  const selText = range ? words.slice(range.a, range.b + 1).map(w => w.w).join(' ') : '';

  const cut = () => {
    if (range) { SC.cutWords(range.a, range.b); setSel(null); return; }
    if (pauseSel !== null) {
      const p = pauseAfter.get(pauseSel);
      const r = p && pauseCut(p, 0.3);
      if (r) cutTimeline([r], `Пауза укорочена на ${(r.end - r.start).toFixed(1)} с`);
      setPauseSel(null);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && (range || pauseSel !== null)) { e.preventDefault(); e.stopPropagation(); cut(); }
    else if (e.key === 'Escape' && (range || pauseSel !== null)) { e.stopPropagation(); setSel(null); setPauseSel(null); }
    else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyF') { e.preventDefault(); e.stopPropagation(); setSearchOpen(true); }
    else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyA' && words.length) { e.preventDefault(); e.stopPropagation(); setSel({ a: 0, b: words.length - 1 }); }
  };

  const wordDown = (e: React.MouseEvent, i: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    boxRef.current?.focus();
    setPauseSel(null);
    if (e.shiftKey && sel) { setSel({ a: sel.a, b: i }); return; }
    drag.current = i;
    setSel({ a: i, b: i });
    set({ playhead: words[i].s, playing: false });
    const up = () => { drag.current = null; window.removeEventListener('mouseup', up); };
    window.addEventListener('mouseup', up);
  };
  const wordEnter = (i: number) => { if (drag.current !== null) setSel({ a: drag.current, b: i }); };

  const menu = (e: React.MouseEvent) => {
    openMenu([
      { label: 'Распознать речь заново', icon: <RefreshCw size={14} />, onClick: () => SC.ensureTranscripts({ force: true }) },
      { label: 'Поиск по тексту (Ctrl+F)', icon: <Search size={14} />, onClick: () => setSearchOpen(true) },
    ], e.clientX, e.clientY);
  };

  const hasMain = mainTrack(project).clips.length > 0;
  const head = (
    <div className="panel-head"><ScrollText size={16} /><h3>Текст ролика</h3>
      {words.length > 0 && <span className="muted small-text">{words.length} слов</span>}
      {words.length > 0 && <button className="icon-btn" data-tip="Поиск по тексту (Ctrl+F)" onClick={() => setSearchOpen(v => !v)}><Search size={15} /></button>}
      <button className="icon-btn" data-tip="Ещё" onClick={menu}>⋯</button>
    </div>
  );
  if (!hasMain) return <>{head}<div className="panel-body"><div className="empty-hint">Добавьте видео со звуком на основную дорожку — здесь появится его текст.<br /><br />Удалите слово или фразу в тексте, и они вырежутся из видео. Как в обычном документе.</div></div></>;
  if (!words.length) return <>{head}<div className="panel-body"><TranscribeCard text={'ИИ превратит речь в текст. Потом монтируйте как в документе: выделили фразу, нажали Delete — она вырезана из видео вместе со звуком.'} /></div></>;

  return (
    <>
      {head}
      {searchOpen && (
        <div className="script-search">
          <Search size={14} className="muted" />
          <input autoFocus className="input" placeholder="Найти слово или фразу" value={query} onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') { setSearchOpen(false); setQuery(''); }
              if (e.key === 'Enter' && matches.length) {
                const cur = get().playhead;
                const next = matches.find(([a]) => words[a].s > cur + 0.05) || matches[0];
                setSel({ a: next[0], b: next[1] });
                set({ playhead: words[next[0]].s });
                boxRef.current?.querySelector(`[data-i="${next[0]}"]`)?.scrollIntoView({ block: 'center' });
              }
            }} />
          <span className="small-text muted">{query ? matches.length : ''}</span>
          {matches.length > 0 && <button className="btn small danger" data-tip="Вырезать все найденные места" onClick={() => { SC.cutWordSpans(matches, `Вырезано «${query}» × ${matches.length}`); setQuery(''); }}><Scissors size={12} /> Все</button>}
          <button className="icon-btn" onClick={() => { setSearchOpen(false); setQuery(''); }}><X size={14} /></button>
        </div>
      )}
      <div className="script-tools">
        {pauses.length > 0 && <button className="chip" data-tip="Паузы длиннее 0,7 с станут короткими (0,3 с)" onClick={() => SC.shortenPauses(0.7, 0.3)}><Timer size={12} /> Укоротить паузы: {pauses.length}</button>}
        {fillers.size > 0 && <button className="chip" data-tip="«Эээ», «ммм», «как бы», «короче»…" onClick={() => SC.cutFillersFromText({ confirm: true })}><Eraser size={12} /> Слова-паразиты: {fillers.size}</button>}
        {missing.length > 0 && <button className="chip" data-tip="Есть клипы без расшифровки" onClick={() => SC.ensureTranscripts()}><TriangleAlert size={12} /> Распознать ещё {missing.length}</button>}
      </div>
      <div className="panel-body script-body" ref={boxRef} tabIndex={0} onKeyDown={onKey}>
        {paras.map((p, k) => (
          <p key={k} className="script-par">
            <span className="script-time" onClick={() => set({ playhead: words[p.from].s })}>{formatTime(words[p.from].s)}</span>
            {words.slice(p.from, p.to + 1).map(w => <Word key={w.i} w={w} sel={!!range && w.i >= range.a && w.i <= range.b} filler={fillers.has(w.i)} match={matchSet.has(w.i)}
              pause={pauseAfter.get(w.i)?.end !== undefined && w.i < p.to ? pauseAfter.get(w.i)!.end - pauseAfter.get(w.i)!.start : 0}
              pauseSel={pauseSel === w.i} onDown={wordDown} onEnter={wordEnter}
              onPause={() => { setSel(null); setPauseSel(w.i); boxRef.current?.focus(); }} />)}
          </p>
        ))}
        <div style={{ height: 80 }} />
      </div>
      {(range || pauseSel !== null) && (
        <div className="script-bar">
          <div className="small-text script-bar-text">{range ? `«${selText.length > 70 ? selText.slice(0, 70) + '…' : selText}»` : 'Пауза'}</div>
          <div className="row">
            <button className="btn danger small" onClick={cut}><Scissors size={13} /> Вырезать <kbd>Del</kbd></button>
            {range && <button className="btn small" onClick={() => (playing ? set({ playing: false }) : playRange(words[range.a].s, words[range.b].e))}>{playing ? <Pause size={13} /> : <Play size={13} />} Послушать</button>}
            {range && <button className="btn small ghost" data-tip="Сделать из этого куска короткий ролик" onClick={() => {
              const it: SC.ShortItem = { id: 'sel' + Date.now(), start: Math.max(0, words[range.a].s - 0.15), end: words[range.b].e + 0.25, title: selText.split(/\s+/).slice(0, 7).join(' '), checked: true };
              SC.useShorts.setState(s => ({ items: [it, ...s.items] }));
              toast('success', 'Кусок добавлен в Shorts', { detail: 'Откройте вкладку «Shorts» слева, чтобы сохранить ролик.' });
            }}><Smartphone size={13} /></button>}
            <button className="icon-btn" onClick={() => { setSel(null); setPauseSel(null); }}><X size={14} /></button>
          </div>
        </div>
      )}
    </>
  );
}

function Word({ w, sel, filler, match, pause, pauseSel, onDown, onEnter, onPause }: {
  w: TWord; sel: boolean; filler: boolean; match: boolean; pause: number; pauseSel: boolean;
  onDown: (e: React.MouseEvent, i: number) => void; onEnter: (i: number) => void; onPause: () => void;
}) {
  return (
    <>
      <span data-i={w.i} className={'sw' + (sel ? ' sel' : '') + (filler ? ' filler' : '') + (match ? ' match' : '')}
        onMouseDown={e => onDown(e, w.i)} onMouseEnter={() => onEnter(w.i)}>{w.w}</span>{' '}
      {pause > 0 && <><span className={'sp' + (pauseSel ? ' sel' : '')} data-tip="Пауза. Щёлкните и нажмите Delete, чтобы укоротить" onMouseDown={e => { e.preventDefault(); onPause(); }}>⏸ {pause.toFixed(1).replace('.', ',')} с</span>{' '}</>}
    </>
  );
}

// ── Короткие ролики ──────────────────────────────────
const LENGTHS = { short: [15, 30], mid: [30, 60], long: [60, 90] } as const;

export function ShortsPanel() {
  const project = useStore(s => s.project)!;
  const { items, busy, mode } = SC.useShorts();
  const words = useMemo(() => timelineWords(project), [project]);
  const [count, setCount] = useState(5);
  const [len, setLen] = useState<keyof typeof LENGTHS>('mid');
  const [faces, setFaces] = useState(true);
  const [subs, setSubs] = useState(true);
  const [title, setTitle] = useState(true);
  const playing = useStore(s => s.playing);
  const ai = SC.aiReady();
  const checked = items.filter(i => i.checked).length;
  const find = (even = false) => SC.findShorts({ count, min: LENGTHS[len][0], max: LENGTHS[len][1], even }).catch(e => toast('error', String(e?.message || e)));
  return (
    <>
      <div className="panel-head"><Smartphone size={16} /><h3>Короткие ролики</h3>{items.length > 0 && <span className="muted small-text">{items.length}</span>}</div>
      <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="card">
          <div className="small-text muted">ИИ прочитает речь длинного видео, найдёт самые цепляющие моменты и сделает из них вертикальные ролики для Reels, Shorts и TikTok — с лицом в центре и крупными субтитрами.</div>
          <Slider label="Сколько роликов" value={count} min={1} max={15} step={1} def={5} onChange={setCount} />
          <div className="label">Длина ролика</div>
          <Segmented value={len} onChange={setLen} options={[
            { value: 'short', label: '15–30 с' }, { value: 'mid', label: '30–60 с' }, { value: 'long', label: '1–1,5 мин' },
          ]} />
          <button className="btn primary" disabled={!!busy} onClick={() => find(!ai)}>
            {busy === 'find' ? <><Loader2 size={14} className="spin" /> Ищу моменты…</> : <><Sparkles size={14} /> {ai ? 'Найти лучшие моменты' : 'Нарезать по фразам'}</>}
          </button>
          {!ai && <div className="small-text muted">Без нейросети ролик делится на части по фразам. Чтобы ИИ сам выбирал интересное, <a style={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={() => set({ dialog: 'settings', settingsTab: 'ai' })}>подключите его</a>.</div>}
          {ai && items.length > 0 && <a className="small-text muted" style={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={() => find(true)}>или просто нарезать поровну по фразам</a>}
        </div>
        {items.length > 0 && (
          <>
            <div className="section-title" style={{ margin: 0 }}>{mode === 'ai' ? 'Лучшие моменты' : 'Части ролика'} · отмечено {checked}</div>
            {items.map((it, n) => (
              <div key={it.id} className={'card short-card' + (it.checked ? ' on' : '')}>
                <div className="row" style={{ alignItems: 'flex-start' }}>
                  <button className={'check' + (it.checked ? ' on' : '')} onClick={() => SC.toggleShort(it.id)} data-tip={it.checked ? 'Не сохранять' : 'Сохранить этот ролик'}>{it.checked && <Check size={12} />}</button>
                  <input className="input short-title" value={it.title} onChange={e => SC.updateShort(it.id, { title: e.target.value })} />
                  {it.score !== undefined && <span className="badge" data-tip="Насколько цепляет, по мнению ИИ">{it.score}/10</span>}
                </div>
                <div className="small-text muted">{n + 1}. {formatTime(it.start)}–{formatTime(it.end)} · {Math.round(it.end - it.start)} с</div>
                {it.why && <div className="small-text">{it.why}</div>}
                <div className="small-text muted short-text">{SC.shortText(words, it)}</div>
                <div className="row">
                  <button className="btn small" onClick={() => (playing ? set({ playing: false }) : playRange(it.start, it.end))}>{playing ? <Pause size={12} /> : <Play size={12} />} Посмотреть</button>
                  <button className="btn small ghost" data-tip="Показать на таймлайне" onClick={() => set({ playhead: it.start })}><MapPin size={12} /></button>
                  <button className="icon-btn" style={{ marginLeft: 'auto' }} data-tip="Убрать из списка" onClick={() => SC.useShorts.setState(s => ({ items: s.items.filter(x => x.id !== it.id) }))}><X size={13} /></button>
                </div>
              </div>
            ))}
            <div className="card">
              <Switch checked={faces} onChange={setFaces} label="Следить за лицом" hint="Вертикальный кадр сам держит говорящего в центре. Работает без интернета." />
              <Switch checked={subs} onChange={setSubs} label="Крупные субтитры" hint="По 1–3 слова, произносимое слово подсвечивается" />
              <Switch checked={title} onChange={setTitle} label="Заголовок в начале" hint="Название момента сверху первые 4 секунды" />
              <button className="btn primary" disabled={!!busy || !checked} onClick={() => SC.makeShorts(undefined, { faces, subtitles: subs, title }).then(list => { if (list.length) toast('success', `Ролики поставлены в очередь: ${list.length}`, { detail: 'Прогресс — внизу справа. Можно дальше монтировать.' }); })}>
                {busy === 'make' ? <><Loader2 size={14} className="spin" /> Готовлю…</> : <><Download size={14} /> Сохранить отмеченные ({checked})</>}
              </button>
              <button className="btn ghost small" onClick={() => SC.shortsToMarkers()}><MapPin size={12} /> Отметить моменты на таймлайне</button>
            </div>
          </>
        )}
        {!items.length && !busy && words.length === 0 && mainTrack(project).clips.length > 0 && <div className="empty-hint">Нарезка работает по речи. Если речь ещё не распознана, «Хлопушка» сделает это сам при поиске.</div>}
      </div>
    </>
  );
}
