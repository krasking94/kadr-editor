// Рабочее окно редактора: слева файлы и заготовки, в центре просмотр и таймлайн, справа настройки и ИИ.
import { useEffect, useState } from 'react';
import { SlidersHorizontal, Sparkles } from 'lucide-react';
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
  return (
    <div className="app">
      <TitleBar />
      <div className="workspace">
        <LeftRail tab={panelOpen ? tab : null} onTab={t => { if (t === tab && panelOpen) setPanelOpen(false); else { setTab(t); setPanelOpen(true); } }} />
        {panelOpen && <SidePanel tab={tab} />}
        <div className="center">
          <Preview />
          <Timeline />
        </div>
        {narrow ? (
          <div className="right-dock">
            <div className="segmented" style={{ margin: 8 }}>
              <button className={!assistantOpen ? 'on' : ''} onClick={() => set({ assistantOpen: false })}><SlidersHorizontal size={13} /> Настройки</button>
              <button className={assistantOpen ? 'on' : ''} onClick={() => set({ assistantOpen: true })}><Sparkles size={13} /> ИИ-помощник</button>
            </div>
            {assistantOpen ? <AssistantPanel /> : <Inspector />}
          </div>
        ) : (
          <>
            <Inspector />
            {assistantOpen && <AssistantPanel />}
          </>
        )}
      </div>
      <StatusBar />
      {historyOpen && <HistoryPanel />}
    </div>
  );
}
