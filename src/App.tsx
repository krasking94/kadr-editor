// Корень программы: стартовый экран или редактор, общие окна, клавиатура, автосохранение.
import { useEffect, useRef, useState } from 'react';
import { FilePlus2 } from 'lucide-react';
import { api } from './api';
import { get, set, toast, useStore } from './state/store';
import { confirmDiscard, importFiles, openNewProject, openProjectFile, watchUpdates } from './state/actions';
import { listenToolCalls } from './state/tool-exec';
import { initAssistant } from './state/assistant';
import { loadSettings, watchSystemTheme } from './state/settings-actions';
import { handleKey } from './lib/commands';
import { loadFonts } from './lib/fonts';
import { MenuHost } from './components/ui';
import { Welcome } from './components/Welcome';
import { Editor } from './components/Editor';
import { Toasts } from './components/Toasts';
import { ConfirmDialog } from './components/ConfirmDialog';
import { ExportDialog } from './components/ExportDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { CommandPalette } from './components/CommandPalette';
import { ShortcutsDialog } from './components/ShortcutsDialog';

export function App() {
  const screen = useStore(s => s.screen);
  const dialog = useStore(s => s.dialog);
  const autosaveMinutes = useStore(s => s.settings.autosaveMinutes);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  // Запуск: настройки, шрифты, связь с ИИ
  useEffect(() => {
    loadFonts();
    const offs = [listenToolCalls(), initAssistant(), watchSystemTheme(), watchUpdates()];
    (async () => {
      await loadSettings();
      const info = await api.info();
      set({ info });
      if (!info.ffmpeg.ok) toast('error', 'Не найден FFmpeg', { detail: 'Без него не получится сохранять видео. Переустановите программу.', ttl: 15000 });
      if (info.pendingOpen) openProjectFile(info.pendingOpen);
    })();
    offs.push(api.onOpenPath((path: string) => openProjectFile(path)));
    offs.push(api.onCloseRequest(async () => { if (await confirmDiscard()) api.confirmClose(); }));
    offs.push(api.onMcpClient((ev: { name: string }) => toast('ai', `Подключился внешний ИИ: ${ev.name}`, { detail: 'Его действия видны в редакторе и отменяются как обычно (Ctrl+Z).', ttl: 6000 })));
    return () => offs.forEach(off => off());
  }, []);

  // Горячие клавиши
  useEffect(() => {
    const h = (e: KeyboardEvent) => { handleKey(e); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // Автосохранение: копия проекта на случай сбоя или выключения света
  useEffect(() => {
    if (!autosaveMinutes) return;
    const t = setInterval(() => {
      const s = get();
      if (s.project && s.dirty) api.autosave(s.project, s.savedPath).catch(() => undefined);
    }, autosaveMinutes * 60_000);
    return () => clearInterval(t);
  }, [autosaveMinutes]);

  // Файлы, перетащенные на окно из Проводника
  useEffect(() => {
    const isFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
    const enter = (e: DragEvent) => { if (isFiles(e)) { dragDepth.current++; setDragging(true); } };
    const leave = (e: DragEvent) => { if (isFiles(e) && --dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } };
    const over = (e: DragEvent) => { if (isFiles(e)) e.preventDefault(); };
    // сброс подсветки ловим заранее: панели могут сами принять файлы и остановить событие
    const reset = () => { dragDepth.current = 0; setDragging(false); };
    const drop = async (e: DragEvent) => {
      if (!isFiles(e) || e.defaultPrevented) return;
      e.preventDefault();
      const paths = [...(e.dataTransfer?.files || [])].map(f => api.pathForFile(f)).filter(Boolean);
      const project = paths.find(p => p.toLowerCase().endsWith('.kadr'));
      if (project) { openProjectFile(project); return; }
      if (!paths.length) return;
      if (!get().project) openNewProject();
      importFiles(paths, { toTimeline: !get().project!.tracks.some(t => t.clips.length) });
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    window.addEventListener('drop', reset, true);
    return () => {
      window.removeEventListener('drop', reset, true);
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, []);

  return (
    <>
      {screen === 'welcome' ? <Welcome /> : <Editor />}
      {dialog === 'export' && <ExportDialog />}
      {dialog === 'settings' && <SettingsDialog />}
      {dialog === 'palette' && <CommandPalette />}
      {dialog === 'shortcuts' && <ShortcutsDialog />}
      <ConfirmDialog />
      <Toasts />
      <MenuHost />
      {dragging && (
        <div className="drop-overlay">
          <div><FilePlus2 size={40} />Отпустите, чтобы добавить файлы<small style={{ fontWeight: 400, opacity: .8 }}>Видео, фото, музыка или проект .kadr</small></div>
        </div>
      )}
    </>
  );
}
