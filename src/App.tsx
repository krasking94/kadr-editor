// Корень программы: стартовый экран или редактор, общие окна, клавиатура, автосохранение.
import { useEffect, useRef, useState } from 'react';
import { FilePlus2 } from 'lucide-react';
import { api } from './api';
import { get, set, toast, useStore } from './state/store';
import { confirmDiscard, importFiles, openNewProject, openProjectFile, watchUpdates } from './state/actions';
import { listenToolCalls } from './state/tool-exec';
import { dropFromBrowser, smartPaste } from './state/paste';
import { Tour } from './components/Tour';
import { CoverDialog } from './components/CoverDialog';
import { initAssistant } from './state/assistant';
import { loadSettings, watchSystemTheme } from './state/settings-actions';
import { handleKey } from './lib/commands';
import { loadFonts } from './lib/fonts';
import { MenuHost } from './components/ui';
import { TipHost } from './components/TipHost';
import { Welcome } from './components/Welcome';
import { Editor } from './components/Editor';
import { Toasts } from './components/Toasts';
import { ConfirmDialog } from './components/ConfirmDialog';
import { ExportDialog } from './components/ExportDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { CommandPalette } from './components/CommandPalette';
import { ShortcutsDialog } from './components/ShortcutsDialog';
import { CrashNotice, DraftDialog, MulticamDialog, PreflightDialog, PublishDialog } from './components/V09Dialogs';
import { Prompter } from './components/Prompter';
import { ErrorBoundary } from './components/ErrorBoundary';
import { autoSendReports, installErrorHooks, loadReports } from './state/crash';

export function App() {
  const screen = useStore(s => s.screen);
  const dialog = useStore(s => s.dialog);
  const prompter = useStore(s => s.prompter);
  const autosaveMinutes = useStore(s => s.settings.autosaveMinutes);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  // Запуск: настройки, шрифты, связь с ИИ
  useEffect(() => {
    installErrorHooks();
    loadFonts();
    const offs = [listenToolCalls(), initAssistant(), watchSystemTheme(), watchUpdates()];
    (async () => {
      await loadSettings();
      const info = await api.info();
      set({ info });
      if (!info.ffmpeg.ok) toast('error', 'Не найден FFmpeg', { detail: 'Без него не получится сохранять видео. Переустановите программу.', ttl: 15000 });
      if (info.pendingOpen) openProjectFile(info.pendingOpen);
      await loadReports().catch(() => undefined);
      autoSendReports().catch(() => undefined);
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

  // Ctrl+V: картинка, скриншот, файлы или ссылка из буфера обмена, иначе — скопированные клипы
  useEffect(() => {
    const h = (e: ClipboardEvent) => {
      const el = e.target as HTMLElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      const s = get();
      if (!s.project || s.screen !== 'editor' || (s.dialog && s.dialog !== 'palette')) return;
      e.preventDefault();
      smartPaste(e.clipboardData);
    };
    window.addEventListener('paste', h);
    return () => window.removeEventListener('paste', h);
  }, []);

  // Файлы, перетащенные на окно из Проводника или из браузера
  useEffect(() => {
    const isFiles = (e: DragEvent) => !!e.dataTransfer?.types.some(t => t === 'Files' || t === 'text/uri-list');
    const enter = (e: DragEvent) => { if (isFiles(e)) { dragDepth.current++; setDragging(true); } };
    const leave = (e: DragEvent) => { if (isFiles(e) && --dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } };
    const over = (e: DragEvent) => { if (isFiles(e)) e.preventDefault(); };
    // сброс подсветки ловим заранее: панели могут сами принять файлы и остановить событие
    const reset = () => { dragDepth.current = 0; setDragging(false); };
    const drop = async (e: DragEvent) => {
      if (!isFiles(e) || e.defaultPrevented) return;
      e.preventDefault();
      const paths = [...(e.dataTransfer?.files || [])].map(f => api.pathForFile(f)).filter(Boolean);
      // из браузера: у файла нет пути на диске или это просто ссылка
      if (!paths.length && e.dataTransfer && get().project && get().screen === 'editor') { dropFromBrowser(e.dataTransfer); return; }
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
      {screen === 'welcome' ? <Welcome /> : <ErrorBoundary><Editor /></ErrorBoundary>}
      {dialog === 'export' && <ExportDialog />}
      {dialog === 'settings' && <SettingsDialog />}
      {dialog === 'palette' && <CommandPalette />}
      {dialog === 'shortcuts' && <ShortcutsDialog />}
      {dialog === 'cover' && <CoverDialog />}
      {dialog === 'preflight' && <PreflightDialog />}
      {dialog === 'publish' && <PublishDialog />}
      {dialog === 'draft' && <DraftDialog />}
      {dialog === 'multicam' && <MulticamDialog />}
      {prompter && <Prompter />}
      <CrashNotice />
      <ConfirmDialog />
      <Tour />
      <Toasts />
      <MenuHost />
      <TipHost />
      {dragging && (
        <div className="drop-overlay">
          <div><FilePlus2 size={40} />Отпустите, чтобы добавить файлы<small style={{ fontWeight: 400, opacity: .8 }}>Видео, фото, музыка или проект .kadr</small></div>
        </div>
      )}
    </>
  );
}
