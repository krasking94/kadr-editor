// Все команды программы в одном месте: из них собираются меню, палитра команд (Ctrl+K)
// и горячие клавиши. Клавиши определяются по физической кнопке, поэтому работают и в русской раскладке.
import { api } from '../api';
import { clipEnd, mainTrack, projectDuration } from '../../shared/timeline';
import * as A from '../state/actions';
import * as S from '../state/smart';
import { get, redo, set, toast, undo } from '../state/store';
import { askAssistant } from '../state/assistant';
import { saveSettings } from '../state/settings-actions';

export interface Command {
  id: string;
  label: string;
  group: 'Файл' | 'Правка' | 'Клип' | 'Просмотр' | 'Таймлайн' | 'ИИ' | 'Окно' | 'Помощь';
  keys?: string[];
  run: () => void;
  needsProject?: boolean;
  hint?: string;
}

const sel = () => get().selection;
const needSel = (fn: (ids: string[]) => void) => () => {
  const ids = sel();
  if (!ids.length) { toast('info', 'Сначала выберите клип на таймлайне (щелчок по нему)'); return; }
  fn(ids);
};
const seek = (t: number) => set({ playhead: Math.max(0, Math.min(projectDuration(get().project!), t)), playing: false });

// Точки склейки — начала и концы клипов, чтобы прыгать по ним стрелками вверх/вниз
function editPoints(): number[] {
  const p = get().project!;
  const pts = new Set<number>([0]);
  for (const t of p.tracks) for (const c of t.clips) { pts.add(+c.start.toFixed(3)); pts.add(+clipEnd(c).toFixed(3)); }
  for (const m of p.markers) pts.add(+m.time.toFixed(3));
  return [...pts].sort((a, b) => a - b);
}

function zoomBy(k: number) {
  set(s => ({ zoom: Math.max(4, Math.min(600, s.zoom * k)) }));
}

export const COMMANDS: Command[] = [
  // Файл
  { id: 'new', label: 'Новый проект', group: 'Файл', keys: ['Ctrl+N'], run: () => A.closeProject() },
  { id: 'open', label: 'Открыть проект…', group: 'Файл', keys: ['Ctrl+O'], run: () => A.openProjectFile() },
  { id: 'save', label: 'Сохранить проект', group: 'Файл', keys: ['Ctrl+S'], needsProject: true, run: () => A.saveProject() },
  { id: 'save-as', label: 'Сохранить как…', group: 'Файл', keys: ['Ctrl+Shift+S'], needsProject: true, run: () => A.saveProject(true) },
  { id: 'import', label: 'Добавить файлы…', group: 'Файл', keys: ['Ctrl+I'], needsProject: true, run: async () => A.importFiles(await api.openMediaDialog()) },
  { id: 'export', label: 'Сохранить видео…', group: 'Файл', keys: ['Ctrl+E'], needsProject: true, run: () => set({ dialog: 'export' }) },
  { id: 'snapshot', label: 'Сохранить текущий кадр как картинку', group: 'Файл', needsProject: true, run: () => window.dispatchEvent(new Event('kadr:snapshot')) },
  { id: 'close', label: 'Закрыть проект', group: 'Файл', needsProject: true, run: () => A.closeProject() },

  // Правка
  { id: 'undo', label: 'Отменить', group: 'Правка', keys: ['Ctrl+Z'], needsProject: true, run: undo },
  { id: 'redo', label: 'Вернуть', group: 'Правка', keys: ['Ctrl+Y', 'Ctrl+Shift+Z'], needsProject: true, run: redo },
  { id: 'history', label: 'История шагов', group: 'Правка', keys: ['Ctrl+H'], needsProject: true, run: () => set(s => ({ historyOpen: !s.historyOpen })) },
  { id: 'copy', label: 'Копировать', group: 'Правка', keys: ['Ctrl+C'], needsProject: true, run: needSel(A.copyClips) },
  { id: 'cut', label: 'Вырезать', group: 'Правка', keys: ['Ctrl+X'], needsProject: true, run: needSel(ids => { A.copyClips(ids); A.deleteClips(ids); }) },
  { id: 'paste', label: 'Вставить на линию времени', group: 'Правка', keys: ['Ctrl+V'], needsProject: true, run: A.pasteClips },
  { id: 'duplicate', label: 'Дублировать', group: 'Правка', keys: ['Ctrl+D'], needsProject: true, run: needSel(A.duplicateClips) },
  { id: 'delete', label: 'Удалить', group: 'Правка', keys: ['Delete', 'Backspace'], needsProject: true, run: needSel(ids => A.deleteClips(ids)) },
  { id: 'ripple', label: 'Удалить и сдвинуть остальное', group: 'Правка', keys: ['Shift+Delete'], needsProject: true, run: needSel(A.rippleDelete) },
  { id: 'select-all', label: 'Выбрать все клипы', group: 'Правка', keys: ['Ctrl+A'], needsProject: true, run: A.selectAll },
  { id: 'deselect', label: 'Снять выделение', group: 'Правка', keys: ['Escape'], needsProject: true, run: () => set({ selection: [], tool: 'select' }) },

  // Клип
  { id: 'split', label: 'Разрезать по линии времени', group: 'Клип', keys: ['S', 'Ctrl+B'], needsProject: true, hint: 'Режет клип под красной линией', run: () => {
    const ids = sel();
    const t = get().playhead;
    const p = get().project!;
    const under = ids.filter(id => p.tracks.some(tr => tr.clips.some(c => c.id === id && t > c.start && t < clipEnd(c))));
    if (under.length) under.forEach(id => A.splitAt(t, id)); else A.splitAt(t);
  } },
  { id: 'text', label: 'Добавить текст', group: 'Клип', keys: ['T'], needsProject: true, run: () => { A.addText('Ваш текст'); set({ inspectorTab: 'text' }); } },
  { id: 'marker', label: 'Поставить метку', group: 'Клип', keys: ['M'], needsProject: true, run: () => A.addMarker(get().playhead) },
  { id: 'detach', label: 'Отделить звук от видео', group: 'Клип', needsProject: true, run: needSel(ids => A.detachAudio(ids[0])) },
  { id: 'freeze', label: 'Стоп-кадр', group: 'Клип', needsProject: true, run: needSel(ids => A.freezeFrame(ids[0])) },
  { id: 'speed-up', label: 'Ускорить клип ×2', group: 'Клип', needsProject: true, run: needSel(ids => ids.forEach(id => {
    const c = get().project!.tracks.flatMap(t => t.clips).find(x => x.id === id);
    if (c?.type === 'media') A.updateMediaClip(id, { speed: c.speed * 2 }, 'Скорость клипа', { coalesce: '' });
  })) },
  { id: 'slow-down', label: 'Замедлить клип ×0.5', group: 'Клип', needsProject: true, run: needSel(ids => ids.forEach(id => {
    const c = get().project!.tracks.flatMap(t => t.clips).find(x => x.id === id);
    if (c?.type === 'media') A.updateMediaClip(id, { speed: c.speed / 2 }, 'Скорость клипа', { coalesce: '' });
  })) },

  // Просмотр
  { id: 'play', label: 'Смотреть / пауза', group: 'Просмотр', keys: ['Space', 'K'], needsProject: true, run: () => set(s => ({ playing: !s.playing })) },
  { id: 'prev-frame', label: 'Кадр назад', group: 'Просмотр', keys: ['Left'], needsProject: true, run: () => seek(get().playhead - 1 / get().project!.fps) },
  { id: 'next-frame', label: 'Кадр вперёд', group: 'Просмотр', keys: ['Right'], needsProject: true, run: () => seek(get().playhead + 1 / get().project!.fps) },
  { id: 'back-1s', label: 'Назад на секунду', group: 'Просмотр', keys: ['Shift+Left', 'J'], needsProject: true, run: () => seek(get().playhead - 1) },
  { id: 'fwd-1s', label: 'Вперёд на секунду', group: 'Просмотр', keys: ['Shift+Right', 'L'], needsProject: true, run: () => seek(get().playhead + 1) },
  { id: 'prev-edit', label: 'К предыдущей склейке', group: 'Просмотр', keys: ['Up'], needsProject: true, run: () => { const t = get().playhead; seek([...editPoints()].reverse().find(x => x < t - 0.01) ?? 0); } },
  { id: 'next-edit', label: 'К следующей склейке', group: 'Просмотр', keys: ['Down'], needsProject: true, run: () => { const t = get().playhead; const n = editPoints().find(x => x > t + 0.01); if (n !== undefined) seek(n); } },
  { id: 'home', label: 'В начало', group: 'Просмотр', keys: ['Home'], needsProject: true, run: () => seek(0) },
  { id: 'end', label: 'В конец', group: 'Просмотр', keys: ['End'], needsProject: true, run: () => seek(projectDuration(get().project!)) },
  { id: 'safe', label: 'Сетка и безопасные зоны', group: 'Просмотр', keys: ['G'], needsProject: true, run: () => set(s => ({ safeZones: !s.safeZones })) },
  { id: 'fullscreen', label: 'Полноэкранный режим', group: 'Просмотр', keys: ['F11'], run: () => api.toggleFullscreen() },

  // Таймлайн
  { id: 'tool-select', label: 'Инструмент «Выбор»', group: 'Таймлайн', keys: ['V'], needsProject: true, run: () => set({ tool: 'select' }) },
  { id: 'tool-razor', label: 'Инструмент «Ножницы»', group: 'Таймлайн', keys: ['C'], needsProject: true, run: () => set(s => ({ tool: s.tool === 'razor' ? 'select' : 'razor' })) },
  { id: 'zoom-in', label: 'Приблизить таймлайн', group: 'Таймлайн', keys: ['=', 'Ctrl+='], needsProject: true, run: () => zoomBy(1.4) },
  { id: 'zoom-out', label: 'Отдалить таймлайн', group: 'Таймлайн', keys: ['-', 'Ctrl+-'], needsProject: true, run: () => zoomBy(1 / 1.4) },
  { id: 'zoom-fit', label: 'Показать весь ролик', group: 'Таймлайн', keys: ['Shift+Z', '\\'], needsProject: true, run: A.fitZoom },
  { id: 'snap', label: 'Прилипание клипов (магнит)', group: 'Таймлайн', keys: ['N'], run: () => {
    const on = !get().settings.snapping;
    saveSettings({ snapping: on });
    toast('info', on ? 'Прилипание включено' : 'Прилипание выключено');
  } },
  { id: 'track-video', label: 'Новая дорожка наложения', group: 'Таймлайн', needsProject: true, run: () => A.addTrackAction('video') },
  { id: 'track-text', label: 'Новая дорожка текста', group: 'Таймлайн', needsProject: true, run: () => A.addTrackAction('text') },
  { id: 'track-audio', label: 'Новая звуковая дорожка', group: 'Таймлайн', needsProject: true, run: () => A.addTrackAction('audio') },

  // ИИ
  { id: 'assistant', label: 'ИИ-помощник', group: 'ИИ', keys: ['Ctrl+J'], run: () => set(s => ({ assistantOpen: !s.assistantOpen })) },
  { id: 'silence', label: 'Убрать паузы в речи', group: 'ИИ', needsProject: true, run: () => A.removeSilence() },
  { id: 'subs', label: 'Субтитры из речи', group: 'ИИ', needsProject: true, run: () => A.transcribeProject({ addSubs: true }).catch(() => undefined) },
  { id: 'scenes', label: 'Разрезать видео по сменам сцен', group: 'ИИ', needsProject: true, run: () => {
    const p = get().project!;
    const id = sel().find(i => mainTrack(p).clips.some(c => c.id === i)) || mainTrack(p).clips[0]?.id;
    if (!id) { toast('info', 'На основной дорожке нет видео'); return; }
    A.detectScenes(id).catch(e => toast('error', String(e.message || e)));
  } },
  { id: 'subs-blogger', label: 'Субтитры как у блогеров', group: 'ИИ', needsProject: true, run: () => S.makeSubtitles({ style: 'blogger' }).catch(() => undefined) },
  { id: 'fillers', label: 'Убрать «эээ» и слова-паразиты', group: 'ИИ', needsProject: true, run: () => S.removeFillers().catch(() => undefined) },
  { id: 'reframe', label: 'Вертикальное видео с лицом в центре', group: 'ИИ', needsProject: true, run: () => S.autoReframe().catch(() => undefined) },
  { id: 'studio-voice', label: 'Студийный звук для всего ролика', group: 'ИИ', needsProject: true, run: () => { S.studioVoiceAll(true); } },
  { id: 'ai-review', label: 'ИИ-режиссёр: что улучшить', group: 'ИИ', needsProject: true, run: () => askAssistant(S.DIRECTOR_PROMPT, true) },
  { id: 'ai-chapters', label: 'Главы, описание и хэштеги', group: 'ИИ', needsProject: true, run: () => askAssistant(S.CHAPTERS_PROMPT) },
  { id: 'srt-open', label: 'Открыть субтитры (SRT)', group: 'Файл', needsProject: true, run: () => { S.importSubtitles(); } },
  { id: 'srt-save', label: 'Сохранить субтитры (SRT)', group: 'Файл', needsProject: true, run: () => { S.exportSubtitles(); } },

  // Окно и помощь
  { id: 'palette', label: 'Все команды', group: 'Окно', keys: ['Ctrl+K', 'Ctrl+Shift+P'], run: () => set(s => ({ dialog: s.dialog === 'palette' ? null : 'palette' })) },
  { id: 'settings', label: 'Настройки', group: 'Окно', keys: ['Ctrl+,'], run: () => set({ dialog: 'settings', settingsTab: 'general' }) },
  { id: 'ai-settings', label: 'Подключить нейросеть', group: 'Окно', run: () => set({ dialog: 'settings', settingsTab: 'ai' }) },
  { id: 'mcp-settings', label: 'Подключение внешнего ИИ (MCP)', group: 'Окно', run: () => set({ dialog: 'settings', settingsTab: 'mcp' }) },
  { id: 'theme', label: 'Сменить тему (тёмная / светлая)', group: 'Окно', run: () => {
    saveSettings({ theme: document.documentElement.dataset.theme === 'light' ? 'dark' : 'light' });
  } },
  { id: 'shortcuts', label: 'Горячие клавиши', group: 'Помощь', keys: ['F1', 'Shift+/'], run: () => set({ dialog: 'shortcuts' }) },
  { id: 'devtools', label: 'Инструменты разработчика', group: 'Помощь', keys: ['Ctrl+Shift+I'], run: () => api.devtools() },
  { id: 'site', label: 'Страница программы на GitHub', group: 'Помощь', run: () => api.openExternal('https://github.com/krasking94/kadr-editor') },
  { id: 'issue', label: 'Сообщить об ошибке', group: 'Помощь', run: () => api.openExternal('https://github.com/krasking94/kadr-editor/issues/new') },
  { id: 'about', label: 'О программе', group: 'Помощь', run: () => set({ dialog: 'settings', settingsTab: 'about' }) },
];

export const commandById = (id: string) => COMMANDS.find(c => c.id === id)!;
export const keysOf = (id: string) => commandById(id)?.keys?.[0];

// Название нажатой клавиши в том же виде, что в списке: «Ctrl+Shift+S», «Space», «Left»
export function comboFromEvent(e: KeyboardEvent): string {
  const code = e.code;
  let key = code;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (code.startsWith('Arrow')) key = code.slice(5);
  else if (code === 'Equal' || code === 'NumpadAdd') key = '=';
  else if (code === 'Minus' || code === 'NumpadSubtract') key = '-';
  else if (code === 'Comma') key = ',';
  else if (code === 'Slash') key = '/';
  else if (code === 'Backslash') key = '\\';
  else if (code === 'Space') key = 'Space';
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  parts.push(key);
  return parts.join('+');
}

const KEY_LABEL: Record<string, string> = { Left: '←', Right: '→', Up: '↑', Down: '↓', Space: 'Пробел', Delete: 'Del', Backspace: '⌫', Escape: 'Esc' };
export const prettyKeys = (k?: string) => (k ? k.split('+').map(x => KEY_LABEL[x] || x).join(' + ') : '');

// Обработчик клавиатуры для всего окна
export function handleKey(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement;
  const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
  const combo = comboFromEvent(e);
  if (typing) {
    // в полях ввода работают только общие сочетания
    if (!['Ctrl+S', 'Ctrl+K', 'Ctrl+E', 'Ctrl+J', 'Ctrl+,', 'F1', 'F11'].includes(combo)) return false;
  }
  const s = get();
  if (s.dialog && s.dialog !== 'palette' && combo !== 'Ctrl+K') return false;
  const cmd = COMMANDS.find(c => c.keys?.includes(combo));
  if (!cmd) return false;
  if (cmd.needsProject && (!s.project || s.screen !== 'editor')) return false;
  if (cmd.id === 'deselect' && !s.selection.length && s.tool === 'select') return false;
  e.preventDefault();
  cmd.run();
  return true;
}
