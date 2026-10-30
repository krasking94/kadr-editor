// Рабочее окно редактора: слева файлы и заготовки, в центре просмотр и таймлайн, справа настройки и ИИ.
import { useEffect, useState, type ReactNode } from 'react';
import { SlidersHorizontal, Sparkles } from 'lucide-react';
import { layoutOf, saveLayout } from '../state/settings-actions';
import type { Layout } from '../../shared/settings';
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

export function Editor() {
  const assistantOpen = useStore(s => s.assistantOpen);
  const historyOpen = useStore(s => s.historyOpen);
  const [tab, setTab] = useState<RailTab>('media');
  const [panelOpen, setPanelOpen] = useState(true);
  const [width, setWidth] = useState(window.innerWidth);
  useEffect(() => {
    const h = () => setWidth(window.innerWidth);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);
  // на небольшом экране настройки клипа и ИИ-помощник делят одну колонку справа
  const narrow = width < 1760;
  const selection = useStore(s => s.selection);
  useEffect(() => {
    if (narrow && selection.length && !useAssistant.getState().busy) set({ assistantOpen: false });
  }, [selection.join(',')]);
  const layout = layoutOf(useStore(s => s.settings));
  const [live, setLive] = useState<Partial<Layout>>({});
  const L = { ...layout, ...live };
  const swap = L.swap;
  // Разделитель между панелями: тянешь — меняется ширина, отпускаешь — запоминается
  const splitter = (key: 'side' | 'right' | 'assistant', grow: 1 | -1, min: number, max: number) => (
    <div className="splitter" data-tip="Потяните, чтобы изменить ширину. Двойной щелчок — как было" data-tip-pos="bottom"
      onDoubleClick={() => { setLive({}); saveLayout({ [key]: ({ side: 320, right: 340, assistant: 360 })[key] }); }}
      onPointerDown={e => {
        e.preventDefault();
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
  const rail = <LeftRail right={swap} tab={panelOpen ? tab : null} onTab={t => { if (t === tab && panelOpen) setPanelOpen(false); else { setTab(t); setPanelOpen(true); } }} />;
  // сторона «файлы и заготовки»: рейка с кнопками + панель
  const files: ReactNode = swap
    ? <>{panelOpen && splitter('side', -1, 240, 640)}{panelOpen && <SidePanel tab={tab} width={L.side} />}{rail}</>
    : <>{rail}{panelOpen && <SidePanel tab={tab} width={L.side} />}{panelOpen && splitter('side', 1, 240, 640)}</>;
  // сторона «настройки клипа и ИИ-помощник»
  const g = swap ? 1 : -1;
  const tools: ReactNode = narrow ? (
    <>
      {!swap && splitter('right', g, 280, 620)}
      <div className="right-dock" style={{ width: L.right }}>
        <div className="segmented" style={{ margin: 8 }}>
          <button className={!assistantOpen ? 'on' : ''} onClick={() => set({ assistantOpen: false })}><SlidersHorizontal size={13} /> Настройки</button>
          <button className={assistantOpen ? 'on' : ''} onClick={() => set({ assistantOpen: true })}><Sparkles size={13} /> ИИ-помощник</button>
        </div>
        {assistantOpen ? <AssistantPanel /> : <Inspector />}
      </div>
      {swap && splitter('right', g, 280, 620)}
    </>
  ) : swap ? (
    <>
      {assistantOpen && <div className="dock-col" style={{ width: L.assistant }}><AssistantPanel /></div>}
      {assistantOpen && splitter('assistant', 1, 280, 700)}
      <div className="dock-col" style={{ width: L.right }}><Inspector /></div>
      {splitter('right', 1, 260, 620)}
    </>
  ) : (
    <>
      {splitter('right', -1, 260, 620)}
      <div className="dock-col" style={{ width: L.right }}><Inspector /></div>
      {assistantOpen && splitter('assistant', -1, 280, 700)}
      {assistantOpen && <div className="dock-col" style={{ width: L.assistant }}><AssistantPanel /></div>}
    </>
  );
  return (
    <div className={'app' + (swap ? ' swapped' : '')}>
      <TitleBar />
      <div className="workspace">
        {swap ? tools : files}
        <div className="center">
          <Preview />
          <Timeline />
        </div>
        {swap ? files : tools}
      </div>
      <StatusBar />
      {historyOpen && <HistoryPanel />}
    </div>
  );
}
