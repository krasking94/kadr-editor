// Переписка со встроенным ИИ-помощником. Живёт отдельно от панели, чтобы чат не терялся при её закрытии.
import { create } from 'zustand';
import { api } from '../api';
import { TOOL_TITLES } from '../../shared/tools';
import { get as getEditor, set as setEditor } from './store';
import { renderFrame } from './actions';

export type ChatItem =
  | { kind: 'user'; id: string; text: string; image?: string }
  | { kind: 'bot'; id: string; text: string }
  | { kind: 'tool'; id: string; name: string; title: string; detail: string; status: 'running' | 'ok' | 'fail'; result?: string; image?: string }
  | { kind: 'error'; id: string; text: string }
  | { kind: 'info'; id: string; text: string };

interface AssistantState {
  items: ChatItem[];
  busy: boolean;
  thinking: boolean;
  sessionId: string;
}

export const useAssistant = create<AssistantState>(() => ({ items: [], busy: false, thinking: false, sessionId: 's' + Date.now() }));
const set = useAssistant.setState;
const get = useAssistant.getState;
let seq = 0;
const nid = () => 'i' + ++seq;

// Короткое описание аргументов команды, чтобы было видно, что именно делает ИИ
function describeArgs(name: string, a: any): string {
  if (!a || typeof a !== 'object') return '';
  if (name === 'add_text' || name === 'update_text') return a.text ? `«${String(a.text).slice(0, 40)}»` : '';
  if (name === 'get_frame' || name === 'split_clip') return a.time !== undefined ? `на ${Number(a.time).toFixed(1)} с` : '';
  if (name === 'set_transition') return a.type || '';
  if (name === 'add_subtitles') return `${(a.items || []).length} строк`;
  if (name === 'export_video') return a.format || 'mp4';
  if (name === 'set_project') return a.preset || (a.width ? `${a.width}×${a.height}` : '');
  if (name.startsWith('ext__')) return name.split('__')[1] || '';
  return '';
}

export function initAssistant() {
  return api.onAiEvent((ev: any) => {
    if (ev.sessionId !== get().sessionId) return;
    switch (ev.type) {
      case 'thinking':
        set({ thinking: true });
        break;
      case 'text':
        set(s => ({ thinking: false, items: [...s.items, { kind: 'bot', id: nid(), text: ev.text }] }));
        break;
      case 'tool': {
        const title = TOOL_TITLES[ev.name] || (ev.name.startsWith('ext__') ? 'Внешний инструмент: ' + ev.name.split('__').slice(2).join('__') : ev.name);
        set(s => ({ thinking: false, items: [...s.items, { kind: 'tool', id: ev.id, name: ev.name, title, detail: describeArgs(ev.name, ev.args), status: 'running' }] }));
        break;
      }
      case 'tool_done':
        set(s => ({ items: s.items.map(i => (i.kind === 'tool' && i.id === ev.id ? { ...i, status: ev.ok ? 'ok' : 'fail', result: ev.ok ? undefined : ev.text, image: ev.image } : i)) }));
        break;
      case 'error':
        set(s => ({ thinking: false, items: [...s.items, { kind: 'error', id: nid(), text: ev.text }] }));
        break;
      case 'info':
        set(s => ({ items: [...s.items, { kind: 'info', id: nid(), text: ev.text }] }));
        break;
      case 'done':
        set({ busy: false, thinking: false });
        break;
    }
  });
}

export async function askAssistant(text: string, withFrame = false) {
  const t = text.trim();
  if (!t || get().busy) return;
  setEditor({ assistantOpen: true });
  let image: string | undefined;
  if (withFrame && getEditor().project) {
    try { image = await renderFrame(getEditor().playhead, 960); } catch { /* без кадра */ }
  }
  set(s => ({ busy: true, thinking: true, items: [...s.items, { kind: 'user', id: nid(), text: t, image: image ? 'data:image/jpeg;base64,' + image : undefined }] }));
  await api.aiChat(get().sessionId, t, image ? ['data:image/jpeg;base64,' + image] : []);
}

export function stopAssistant() {
  api.aiStop();
}

export function resetAssistant() {
  api.aiReset(get().sessionId);
  set({ items: [], busy: false, thinking: false, sessionId: 's' + Date.now() });
}
