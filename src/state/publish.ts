// Публикация в один клик (с 0.9): YouTube, ВКонтакте и Telegram. Само видео отправляет главный процесс,
// здесь — состояние окна, вход в аккаунты и подсказка названия и описания от нейросети.
import { create } from 'zustand';
import { api } from '../api';
import { projectDuration } from '../../shared/timeline';
import { timelineWords, transcriptForAi } from '../../shared/transcript';
import { get, set, toast } from './store';
import { aiReady } from './script';

export type Platform = 'youtube' | 'vk' | 'telegram';
export const PLATFORMS: { id: Platform; label: string; color: string }[] = [
  { id: 'youtube', label: 'YouTube', color: '#ff3b30' },
  { id: 'vk', label: 'ВКонтакте', color: '#2787f5' },
  { id: 'telegram', label: 'Telegram', color: '#29a9eb' },
];

export interface PublishResult { platform: Platform; ok: boolean; url?: string; error?: string; warning?: string }

interface PublishState {
  status: Record<Platform, boolean>;
  who: Partial<Record<Platform, string>>; // имя канала или аккаунта после входа
  busy: boolean;
  progress: Partial<Record<Platform, { k: number; text?: string }>>;
  results: PublishResult[] | null;
  suggest?: { title?: string; description?: string; tags?: string[] }; // что предложил ИИ-помощник
}
export const usePublish = create<PublishState>(() => ({ status: { youtube: false, vk: false, telegram: false }, who: {}, busy: false, progress: {}, results: null }));

const clean = (e: unknown) => String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export async function refreshPublishStatus() {
  usePublish.setState({ status: await api.publishStatus() });
}

export async function loginPlatform(p: Platform): Promise<boolean> {
  try {
    const who: string = await api.publishLogin(p);
    usePublish.setState(s => ({ who: { ...s.who, [p]: who } }));
    await refreshPublishStatus();
    toast('success', `${PLATFORMS.find(x => x.id === p)!.label}: ${who}`);
    return true;
  } catch (e) {
    toast('error', 'Не удалось подключиться', { detail: clean(e), ttl: 9000 });
    return false;
  }
}

export async function logoutPlatform(p: Platform) {
  usePublish.setState({ status: await api.publishLogout(p) });
}

export interface PublishInput {
  file: string; title: string; description: string; tags: string[]; cover?: string; privacy?: 'private' | 'unlisted' | 'public';
}

export async function publishVideo(input: PublishInput, platforms: Platform[]): Promise<PublishResult[]> {
  if (!platforms.length) { toast('info', 'Отметьте, куда отправить видео'); return []; }
  const p = get().project;
  const jobId = 'pub' + Date.now();
  usePublish.setState({ busy: true, results: null, progress: Object.fromEntries(platforms.map(x => [x, { k: 0 }])) });
  const off = api.onPublishProgress((ev: { jobId: string; platform: Platform; progress: number; text?: string }) => {
    if (ev.jobId === jobId) usePublish.setState(s => ({ progress: { ...s.progress, [ev.platform]: { k: ev.progress, text: ev.text } } }));
  });
  try {
    const req = { ...input, width: p?.width, height: p?.height, duration: p ? projectDuration(p) : undefined };
    const results: PublishResult[] = await api.publishRun(jobId, req, platforms);
    usePublish.setState({ results });
    const good = results.filter(r => r.ok);
    if (good.length === results.length) toast('success', 'Видео опубликовано!', { detail: good.map(r => r.url).filter(Boolean).join('\n'), ttl: 12000 });
    else if (good.length) toast('warn', `Опубликовано: ${good.length} из ${results.length}`, { detail: results.filter(r => !r.ok).map(r => r.error).join('\n'), ttl: 12000 });
    else toast('error', 'Не получилось опубликовать', { detail: results.map(r => r.error).join('\n'), ttl: 12000 });
    return results;
  } finally {
    off();
    usePublish.setState({ busy: false });
  }
}

const META_SYSTEM = `You write titles and descriptions for videos on YouTube, VK and Telegram.
You get the video transcript (one phrase per line: [start-end seconds] text) or just the project name.
Write in the language of the video (usually Russian). Reply with ONLY JSON:
{"title": "catchy honest title, max 70 chars, no clickbait lies", "description": "2-4 short sentences about what the viewer gets, then a line with chapters 00:00 Name if the video is longer than 2 minutes", "tags": ["5-10 short tags without #"]}`;

/** Название, описание и теги от нейросети по тексту речи ролика */
export async function suggestMeta(): Promise<{ title: string; description: string; tags: string[] }> {
  const p = get().project!;
  if (!aiReady()) throw new Error('Подключите нейросеть: Настройки → Нейросети');
  const words = timelineWords(p);
  const input = words.length ? transcriptForAi(words, 40_000) : `Project name: ${p.name}. Duration: ${Math.round(projectDuration(p))} s. No transcript.`;
  const reply: string = await api.aiComplete(META_SYSTEM, input);
  const m = reply.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Нейросеть ответила не в том формате');
  const j = JSON.parse(m[0]) as { title?: string; description?: string; tags?: string[] };
  return { title: String(j.title || '').slice(0, 100), description: String(j.description || ''), tags: (j.tags || []).map(t => String(t).replace(/^#/, '')).slice(0, 15) };
}

export const openPublish = () => set({ dialog: 'publish' });
