// Рабочее окно редактора: в центре просмотр и таймлайн, по краям панели — файлы, настройки клипа и ИИ.
// Панели — свободные окна: любую можно оторвать за заголовок, поставить где удобно или пристыковать к краю.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { GripVertical, Pin, SlidersHorizontal, Sparkles, X } from 'lucide-react';
import { layoutOf, saveLayout } from '../state/settings-actions';
import type { FloatRect, Layout, PaneId } from '../../shared/settings';
import { clampRect, docksOf, homeTarget, movePane, PANE_TITLES, PANE_WIDTH, type DockTarget } from '../../shared/layout';
import { set, useStore } from '../state/store';
import { useAssistant } from '../state/assistant';
import { TitleBar } from './TitleBar';
import { SidePanel, LeftRail, type RailTab } from './SidePanel';
import { Preview } from './Preview';
import { Timeline } from './Timeline';
import { Inspector } from './Inspector';
import { AssistantPanel } from './AssistantPanel';
import { StatusBar } from './StatusBar';
import { HistoryPanel } from './HistoryPanel';

type Side = 'left' | 'right';
// Куда упадёт панель, если отпустить мышь: место между колонками у края
interface Hit { side: Side; index: number; x: number; top: number; bottom: number }
interface Drag { id: PaneId; rect: FloatRect; hit: Hit | null; floating: boolean }

const WIDTH_DEFAULTS = { side: 320, right: 340, assistant: 360 };
const WIDTH_LIMITS = { side: [240, 640], right: [260, 620], assistant: [280, 700] } as const;

// Места для стыковки: границы между пристыкованными колонками и края программы
function dropHit(px: number, py: number): Hit | null {
  const ws = document.querySelector('.workspace')?.getBoundingClientRect();
  const center = document.querySelector('.workspace > .center')?.getBoundingClientRect();
  if (!ws || !center || py < ws.top || py > ws.bottom) return null;
  const spots: Hit[] = [];
  const add = (side: Side, index: number, x: number) => spots.push({ side, index, x, top: ws.top, bottom: ws.bottom });
  for (const side of ['left', 'right'] as Side[]) {
    const cols = [...document.querySelectorAll<HTMLElement>(`.workspace > .dock-col[data-side="${side}"]`)];
    if (!cols.length) { add(side, 0, side === 'left' ? center.left : center.right); continue; }
    cols.forEach((el, k) => {
      const r = el.getBoundingClientRect();
      const i = Number(el.dataset.i), n = Number(el.dataset.n);
      if (side === 'left') { if (k === 0) add(side, i, r.left); add(side, i + n, r.right); }
      else { add(side, i, r.left); if (k === cols.length - 1) add(side, i + n, r.right); }
    });
  }
  // к самому краю окна тоже можно подтащить
  let best: Hit | null = null, bd = 64;
  for (const s of spots) {
    const d = Math.abs(px - s.x);
    if (d < bd) { bd = d; best = s; }
  }
  if (!best && px < ws.left + 40) best = spots.find(s => s.side === 'left' && s.index === 0) || null;
  if (!best && px > ws.right - 40) best = spots.filter(s => s.side === 'right').pop() || null;
  return best;
}

export function Editor() {
  const assistantOpen = useStore(s => s.assistantOpen);
  const historyOpen = useStore(s => s.historyOpen);
  const [tab, setTab] = useState<RailTab>('media');
  const [panelOpen, setPanelOpen] = useState(true);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const h = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);
  // на небольшом экране настройки клипа и ИИ-помощник делят одну колонку
  const narrow = size.w < 1760;
  const selection = useStore(s => s.selection);
  const layout = layoutOf(useStore(s => s.settings));
  const [live, setLive] = useState<Partial<Layout>>({});
  const L = { ...layout, ...live };
  const docks = docksOf(L);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [front, setFront] = useState<PaneId | null>(null);
  const shared = (list: PaneId[]) => {
    const a = list.indexOf('inspector'), b = list.indexOf('assistant');
    return narrow && a >= 0 && b >= 0 && Math.abs(a - b) === 1;
  };
  const combined = shared(docks.left) || shared(docks.right);
  useEffect(() => {
    if (combined && selection.length && !useAssistant.getState().busy) set({ assistantOpen: false });
  }, [selection.join(',')]);

  // Разделитель между панелями: тянешь — меняется ширина, отпускаешь — запоминается
  const splitter = (key: 'side' | 'right' | 'assistant', grow: 1 | -1) => (
    <div className="splitter" key={'sp-' + key} data-tip="Потяните, чтобы изменить ширину. Двойной щелчок — как было" data-tip-pos="bottom"
      onDoubleClick={() => { setLive({}); saveLayout({ [key]: WIDTH_DEFAULTS[key] }); }}
      onPointerDown={e => {
        e.preventDefault();
        const [min, max] = WIDTH_LIMITS[key];
        const x0 = e.clientX, w0 = L[key];
        let last = w0;
        document.body.classList.add('resizing');
        const move = (ev: PointerEvent) => { last = Math.round(Math.max(min, Math.min(max, w0 + (ev.clientX - x0) * grow))); setLive(v => ({ ...v, [key]: last })); };
        const up = () => {
          window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
          document.body.classList.remove('resizing');
          saveLayout({ [key]: last }).then(() => setLive({}));
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }} />
  );

  const place = (id: PaneId, to: DockTarget) => saveLayout(movePane(layoutOf(useStore.getState().settings), id, to));

  // Перетаскивание панели: за заголовок пристыкованной или за полоску плавающей
  const startDrag = (id: PaneId, e: React.PointerEvent, from: FloatRect, floating: boolean) => {
    if (e.button !== 0) return;
    const x0 = e.clientX, y0 = e.clientY;
    let started = floating, cur: Drag = { id, rect: from, hit: null, floating };
    const finish = (drop: boolean) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('keydown', key);
      document.body.classList.remove('pane-dragging');
      setDrag(null);
      if (!drop || !started) return;
      if (cur.hit) place(id, { side: cur.hit.side, index: cur.hit.index });
      else if (cur.rect.x !== from.x || cur.rect.y !== from.y || !floating) place(id, { float: clampRect(cur.rect, window.innerWidth, window.innerHeight) });
    };
    const move = (ev: PointerEvent) => {
      if (!started && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 8) return;
      if (!started) { started = true; document.body.classList.add('pane-dragging'); }
      const rect = { ...from, x: from.x + ev.clientX - x0, y: from.y + ev.clientY - y0 };
      // Shift — не стыковать, просто положить окно
      cur = { id, rect, hit: ev.shiftKey ? null : dropHit(ev.clientX, ev.clientY), floating };
      setDrag(cur);
    };
    const up = () => finish(true);
    const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { started = false; finish(false); } };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', key);
  };

  // Заголовок пристыкованной панели — ручка для отрыва (кнопки и поля внутри заголовка работают как обычно)
  const headDrag = (id: PaneId | (() => PaneId)) => (e: React.PointerEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (!t.closest('.panel-head, .pane-grip') || t.closest('button:not(.pane-grip), input, select, textarea, a')) return;
    const col = e.currentTarget.getBoundingClientRect();
    const pid = typeof id === 'function' ? id() : id;
    startDrag(pid, e, { x: col.left, y: col.top, w: col.width, h: Math.min(col.height, 640) }, false);
  };

  const rail = (side: Side) => (
    <LeftRail key="rail" right={side === 'right'} tab={panelOpen ? tab : null}
      onTab={t => { if (t === tab && panelOpen) setPanelOpen(false); else { setTab(t); setPanelOpen(true); } }} />
  );
  const content = (id: PaneId): ReactNode => (id === 'files' ? <SidePanel tab={tab} /> : id === 'inspector' ? <Inspector /> : <AssistantPanel />);
  const visible = (id: PaneId) => (id === 'files' ? panelOpen : id === 'assistant' ? assistantOpen : true);
  const grip = (title: string) => (
    <button className="pane-grip" data-tip={`Потяните, чтобы открепить «${title}» отдельным окном`} data-tip-pos="left"><GripVertical size={13} /></button>
  );

  // Одна сторона: колонки слева направо, у каждой разделитель со стороны центра
  const side = (s: Side): ReactNode[] => {
    const list = s === 'left' ? docks.left : docks.right;
    const out: ReactNode[] = [];
    if (s === 'left' && docks.rail === 'left' && !list.includes('files')) out.push(rail('left'));
    for (let i = 0; i < list.length; i++) {
      const id = list[i];
      const pair = narrow && (id === 'inspector' || id === 'assistant') && (list[i + 1] === 'inspector' || list[i + 1] === 'assistant');
      if (pair) {
        // на небольшом экране — одна колонка с переключателем «Настройки / ИИ-помощник»
        const col = (
          <div key="tools" className="dock-col right-dock" data-side={s} data-i={i} data-n={2} style={{ width: L.right }}
            onPointerDown={headDrag(() => (useStore.getState().assistantOpen ? 'assistant' : 'inspector'))}>
            <div className="segmented" style={{ margin: 8 }}>
              <button className={!assistantOpen ? 'on' : ''} onClick={() => set({ assistantOpen: false })}><SlidersHorizontal size={13} /> Настройки</button>
              <button className={assistantOpen ? 'on' : ''} onClick={() => set({ assistantOpen: true })}><Sparkles size={13} /> ИИ-помощник</button>
            </div>
            {grip(assistantOpen ? PANE_TITLES.assistant : PANE_TITLES.inspector)}
            {assistantOpen ? <AssistantPanel /> : <Inspector />}
          </div>
        );
        if (s === 'right') out.push(splitter('right', -1));
        out.push(col);
        if (s === 'left') out.push(splitter('right', 1));
        i++;
        continue;
      }
      if (id === 'files' && s === 'left') out.push(rail('left'));
      if (visible(id)) {
        const key = PANE_WIDTH[id];
        if (s === 'right') out.push(splitter(key, -1));
        out.push(
          <div key={id} className={'dock-col pane-' + id} data-side={s} data-i={i} data-n={1} style={{ width: L[key] }} onPointerDown={headDrag(id)}>
            {grip(PANE_TITLES[id])}
            {content(id)}
          </div>,
        );
        if (s === 'left') out.push(splitter(key, 1));
      }
      if (id === 'files' && s === 'right') out.push(rail('right'));
    }
    if (s === 'right' && docks.rail === 'right' && !list.includes('files')) out.push(rail('right'));
    return out;
  };

  const floats = (Object.keys(docks.float) as PaneId[]).filter(visible);
  return (
    <div className="app">
      <TitleBar />
      <div className="workspace">
        {side('left')}
        <div className="center">
          <Preview />
          <Timeline />
        </div>
        {side('right')}
      </div>
      <StatusBar />
      {floats.map(id => (
        <FloatPane key={id} id={id} rect={clampRect(drag?.id === id && drag.floating ? drag.rect : docks.float[id]!, size.w, size.h)} front={front === id}
          onFront={() => setFront(id)}
          onMove={(e, r) => startDrag(id, e, r, true)}
          onResize={r => place(id, { float: r })}
          onDock={() => place(id, homeTarget(L, id))}
          onClose={id === 'inspector' ? undefined : () => (id === 'files' ? setPanelOpen(false) : set({ assistantOpen: false }))}>
          {content(id)}
        </FloatPane>
      ))}
      {drag && (
        <div className="pane-drop-layer">
          {!drag.floating && (
            <div className={'pane-ghost' + (drag.hit ? ' docking' : '')} style={{ left: drag.rect.x, top: drag.rect.y, width: drag.rect.w, height: drag.rect.h }}>
              <span><GripVertical size={14} /> {PANE_TITLES[drag.id]}</span>
            </div>
          )}
          {drag.hit && (
            <div className="pane-drop" style={{ left: drag.hit.x - 3, top: drag.hit.top, height: drag.hit.bottom - drag.hit.top }}>
              <span style={drag.hit.side === 'right' ? { right: 10 } : { left: 10 }}>Пристыковать сюда</span>
            </div>
          )}
          {!drag.hit && <div className="pane-drop-hint">Отпустите — будет отдельное окно. Подведите к краю, чтобы пристыковать. Esc — отмена</div>}
        </div>
      )}
      {historyOpen && <HistoryPanel />}
    </div>
  );
}

// Плавающее окно поверх программы: двигается за полоску сверху, размер — за края
function FloatPane(p: {
  id: PaneId; rect: FloatRect; front: boolean; children: ReactNode;
  onFront: () => void; onMove: (e: React.PointerEvent, r: FloatRect) => void; onResize: (r: FloatRect) => void; onDock: () => void; onClose?: () => void;
}) {
  const [live, setLive] = useState<FloatRect | null>(null);
  const r = live || p.rect;
  const ref = useRef(r);
  ref.current = r;
  const resize = (dir: 'e' | 's' | 'se' | 'w') => (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    const x0 = e.clientX, y0 = e.clientY, r0 = p.rect;
    document.body.classList.add('resizing');
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      const n = { ...r0 };
      if (dir === 'e' || dir === 'se') n.w = r0.w + dx;
      if (dir === 's' || dir === 'se') n.h = r0.h + dy;
      if (dir === 'w') { n.w = r0.w - dx; n.x = r0.x + dx; }
      n.w = Math.max(260, n.w); n.h = Math.max(200, n.h);
      if (dir === 'w') n.x = r0.x + r0.w - n.w;
      setLive(n);
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing');
      p.onResize(clampRect(ref.current, window.innerWidth, window.innerHeight));
      setTimeout(() => setLive(null), 50);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className={'float-pane pane-' + p.id + (p.front ? ' front' : '')} style={{ left: r.x, top: r.y, width: r.w, height: r.h }} onPointerDownCapture={p.onFront}>
      <div className="float-head" onPointerDown={e => { if (!(e.target as HTMLElement).closest('button')) p.onMove(e, r); }}
        onDoubleClick={e => { if (!(e.target as HTMLElement).closest('button')) p.onDock(); }}>
        <GripVertical size={14} className="muted" />
        <span>{PANE_TITLES[p.id]}</span>
        <button className="icon-btn small" data-tip="Вернуть на место (или двойной щелчок по полоске)" data-tip-pos="bottom" onClick={p.onDock}><Pin size={13} /></button>
        {p.onClose && <button className="icon-btn small" data-tip="Скрыть" data-tip-pos="bottom" onClick={p.onClose}><X size={14} /></button>}
      </div>
      <div className="float-body">{p.children}</div>
      <div className="float-rs e" onPointerDown={resize('e')} />
      <div className="float-rs w" onPointerDown={resize('w')} />
      <div className="float-rs s" onPointerDown={resize('s')} />
      <div className="float-rs se" onPointerDown={resize('se')} />
    </div>
  );
}
