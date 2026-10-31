// Состояние программы. Любое изменение проекта проходит через commit(): так работает отмена,
// история шагов и подсветка того, что изменилось.
import { create } from 'zustand';
import type { MediaItem, Project } from '../../shared/types';
import { layoutProject, projectDuration } from '../../shared/timeline';
import type { Settings } from '../../shared/settings';
import { defaultSettings } from '../../shared/settings';
import type { AppInfo } from '../api';

export interface MediaCacheEntry {
  thumb?: string;
  filmstrip: string[];
  waveform?: number[];
  loading?: boolean;
}

export type ToastKind = 'info' | 'success' | 'error' | 'ai' | 'warn';
export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
  detail?: string;
  action?: { label: string; run: () => void };
  ttl: number;
}

export interface Task {
  id: string;
  label: string;
  progress?: number; // 0..1
  cancel?: () => void;
}

export interface HistoryEntry {
  label: string;
  source: string; // 'user' | 'assistant' | имя внешнего ИИ
  at: number;
  project: Project;
}

export interface ConfirmRequest {
  title: string;
  text: string;
  buttons: { label: string; kind?: 'primary' | 'danger' | 'ghost'; value: string }[];
  icon?: 'download'; // без него: предупреждение, если есть опасная кнопка, иначе — вопрос
  resolve: (value: string) => void;
}

export interface QueueItem { id: string; name: string; outPath: string; state: 'wait' | 'run' | 'done' | 'error' | 'canceled'; error?: string }
export type Dialog = 'export' | 'settings' | 'palette' | 'shortcuts' | 'about' | 'cover' | 'preflight' | 'publish' | 'draft' | 'multicam' | 'reports' | null;

interface State {
  screen: 'welcome' | 'editor';
  info: AppInfo | null;
  settings: Settings;
  secrets: Record<string, boolean>;
  project: Project | null;
  savedPath: string | null;
  dirty: boolean;
  past: HistoryEntry[];
  future: HistoryEntry[];
  coalesce: { key: string; at: number } | null;
  selection: string[];
  playhead: number;
  playing: boolean;
  zoom: number; // пикселей на секунду
  tool: 'select' | 'razor';
  mediaCache: Record<string, MediaCacheEntry>;
  toasts: Toast[];
  tasks: Task[];
  flash: Record<string, number>;
  lastAction: { label: string; source: string; at: number } | null;
  assistantOpen: boolean;
  historyOpen: boolean;
  dialog: Dialog;
  settingsTab: string;
  confirm: ConfirmRequest | null;
  clipboard: unknown[];
  safeZones: boolean;
  previewScale: number;
  inspectorTab: string;
  exportQueue: QueueItem[];
  trackPick: string | null; // окно просмотра ждёт рамку вокруг объекта для этого клипа (0.9)
  prompter: boolean; // открыт телесуфлёр (0.9)
  lastExport: string | null; // последнее сохранённое видео — его удобно сразу опубликовать (0.9)
}

export const useStore = create<State>(() => ({
  screen: 'welcome',
  info: null,
  settings: defaultSettings(),
  secrets: {},
  project: null,
  savedPath: null,
  dirty: false,
  past: [],
  future: [],
  coalesce: null,
  selection: [],
  playhead: 0,
  playing: false,
  zoom: 80,
  tool: 'select',
  mediaCache: {},
  toasts: [],
  tasks: [],
  flash: {},
  lastAction: null,
  assistantOpen: true,
  historyOpen: false,
  dialog: null,
  settingsTab: 'general',
  confirm: null,
  clipboard: [],
  safeZones: false,
  previewScale: 1,
  inspectorTab: 'main',
  exportQueue: [],
  trackPick: null,
  prompter: false,
  lastExport: null,
}));

export const get = useStore.getState;
export const set = useStore.setState;

const SOURCE_LABEL: Record<string, string> = { user: '', assistant: 'ИИ-помощник' };
export const sourceLabel = (s: string) => SOURCE_LABEL[s] ?? s;

let toastSeq = 0;
export function toast(kind: ToastKind, text: string, opts: { detail?: string; action?: Toast['action']; ttl?: number } = {}) {
  const t: Toast = { id: ++toastSeq, kind, text, detail: opts.detail, action: opts.action, ttl: opts.ttl ?? (kind === 'error' ? 7000 : 3200) };
  set(s => ({ toasts: [...s.toasts.slice(-4), t] }));
  setTimeout(() => set(s => ({ toasts: s.toasts.filter(x => x.id !== t.id) })), t.ttl);
  return t.id;
}

export function dismissToast(id: number) {
  set(s => ({ toasts: s.toasts.filter(x => x.id !== id) }));
}

export function startTask(label: string, cancel?: () => void): string {
  const id = 'task' + Math.random().toString(36).slice(2, 8);
  set(s => ({ tasks: [...s.tasks, { id, label, cancel }] }));
  return id;
}
export function updateTask(id: string, patch: Partial<Task>) {
  set(s => ({ tasks: s.tasks.map(t => (t.id === id ? { ...t, ...patch } : t)) }));
}
export function endTask(id: string) {
  set(s => ({ tasks: s.tasks.filter(t => t.id !== id) }));
}

export interface CommitOptions {
  coalesce?: string; // одинаковый ключ за 1.2 с — один шаг истории (ползунки)
  source?: string;
  flash?: string[];
  quiet?: boolean; // не показывать всплывающее сообщение
}

/** Изменить проект: fn меняет копию, старая версия уходит в историю. */
export function commit(label: string, fn: (p: Project) => void | string[], opts: CommitOptions = {}): string[] {
  const s = get();
  if (!s.project) return [];
  const before = s.project;
  const next: Project = structuredClone(before);
  const touched = fn(next) || [];
  layoutProject(next);
  next.updatedAt = Date.now();
  const source = opts.source || 'user';
  const now = Date.now();
  const sameStep = opts.coalesce && s.coalesce && s.coalesce.key === opts.coalesce && now - s.coalesce.at < 1200;
  const past = sameStep ? s.past : [...s.past.slice(-199), { label, source, at: now, project: before }];
  const flashIds = [...(opts.flash || []), ...touched];
  const flash = { ...s.flash };
  for (const id of flashIds) flash[id] = now;
  const dur = projectDuration(next);
  set({
    project: next, past, future: [], dirty: true,
    coalesce: opts.coalesce ? { key: opts.coalesce, at: now } : null,
    lastAction: { label, source, at: now }, flash,
    playhead: Math.min(s.playhead, Math.max(0, dur)),
  });
  if (source !== 'user') toast('ai', label, { detail: sourceLabel(source), ttl: 2600 });
  else if (!opts.quiet && !opts.coalesce) toast('info', label, { ttl: 1800 });
  return touched;
}

export function undo() {
  const s = get();
  const last = s.past[s.past.length - 1];
  if (!last || !s.project) { toast('info', 'Отменять больше нечего'); return; }
  set({
    project: last.project, past: s.past.slice(0, -1),
    future: [{ ...last, project: s.project }, ...s.future], dirty: true, coalesce: null,
    lastAction: { label: 'Отменено: ' + last.label, source: 'user', at: Date.now() },
  });
  toast('info', 'Отменено: ' + last.label, { ttl: 1800 });
}

export function redo() {
  const s = get();
  const next = s.future[0];
  if (!next || !s.project) { toast('info', 'Возвращать нечего'); return; }
  set({
    project: next.project, future: s.future.slice(1),
    past: [...s.past, { ...next, project: s.project }], dirty: true, coalesce: null,
    lastAction: { label: 'Возвращено: ' + next.label, source: 'user', at: Date.now() },
  });
  toast('info', 'Возвращено: ' + next.label, { ttl: 1800 });
}

/** Вернуть проект к состоянию после шага index истории (-1 — к самому началу) */
export function jumpToHistory(index: number) {
  const s = get();
  const target = index + 1; // сколько шагов должно остаться в past
  if (target < s.past.length) {
    const steps = s.past.length - target;
    for (let i = 0; i < steps; i++) {
      const st = get();
      const last = st.past[st.past.length - 1];
      set({ project: last.project, past: st.past.slice(0, -1), future: [{ ...last, project: st.project! }, ...st.future], dirty: true });
    }
  } else {
    const steps = target - s.past.length;
    for (let i = 0; i < steps; i++) {
      const st = get();
      const next = st.future[0];
      if (!next) break;
      set({ project: next.project, future: st.future.slice(1), past: [...st.past, { ...next, project: st.project! }], dirty: true });
    }
  }
  set({ coalesce: null });
}

export function askConfirm(req: Omit<ConfirmRequest, 'resolve'>): Promise<string> {
  return new Promise(resolve => set({ confirm: { ...req, resolve: v => { set({ confirm: null }); resolve(v); } } }));
}

export function patchMediaCache(id: string, patch: Partial<MediaCacheEntry>) {
  set(s => ({ mediaCache: { ...s.mediaCache, [id]: { ...(s.mediaCache[id] ?? { filmstrip: [] }), ...patch } } }));
}

/**
 * Служебные сведения о файле (расшифровка речи, лёгкая копия) — не шаг монтажа.
 * Записываются сразу во все версии проекта в истории, чтобы Ctrl+Z их не стирал.
 */
export function patchMediaEverywhere(id: string, patch: Partial<MediaItem>) {
  const fix = (p: Project): Project => (p.media.some(m => m.id === id) ? { ...p, media: p.media.map(m => (m.id === id ? { ...m, ...patch } : m)) } : p);
  const s = get();
  if (!s.project) return;
  set({
    project: fix(s.project), dirty: true,
    past: s.past.map(h => ({ ...h, project: fix(h.project) })),
    future: s.future.map(h => ({ ...h, project: fix(h.project) })),
  });
}
