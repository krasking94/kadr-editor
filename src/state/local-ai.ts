// 1.0: нейросети на компьютере — скачивание моделей, распознавание речи без интернета и отделение голоса от музыки.
import { api } from '../api';
import { asrModelFor, localModel, mb, modelBundle, type LocalModelId, type LocalModelStatus } from '../../shared/local-models';
import type { MediaClip } from '../../shared/types';
import { clipDuration, findClip, makeMediaClip, mediaById } from '../../shared/timeline';
import { importFiles, trackFor } from './actions';
import { askConfirm, commit, endTask, get, set, startTask, toast, updateTask } from './store';
import { create } from 'zustand';

const clean = (e: unknown) => String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// Состояние моделей для окна настроек: что скачано и что качается прямо сейчас
export const useLocal = create<{ status: LocalModelStatus[]; busy: Partial<Record<LocalModelId, { progress: number; text: string; jobId: string }>> }>(() => ({ status: [], busy: {} }));

export async function refreshLocal(): Promise<LocalModelStatus[]> {
  try {
    const info = await api.localInfo();
    useLocal.setState({ status: info.status });
    return info.status;
  } catch {
    return useLocal.getState().status;
  }
}

const left = (status: LocalModelStatus[], id: LocalModelId) =>
  modelBundle(id).reduce((a, m) => { const s = status.find(x => x.id === m.id); return a + (s && !s.ready ? s.total - s.bytes : s ? 0 : m.files.reduce((b, f) => b + f.size, 0)); }, 0);

export async function modelReady(id: LocalModelId): Promise<boolean> {
  const st = await refreshLocal();
  return modelBundle(id).every(m => st.find(x => x.id === m.id)?.ready);
}

const running = new Map<LocalModelId, Promise<boolean>>();

/** Скачать модель с полосой прогресса. Повторный вызов ждёт уже идущее скачивание. */
export function downloadModel(id: LocalModelId): Promise<boolean> {
  const was = running.get(id);
  if (was) return was;
  const job = (async () => {
    const jobId = 'dl' + Date.now();
    const title = localModel(id).title;
    const task = startTask(`Скачиваю нейросеть «${title}»`, () => api.localDownloadCancel(jobId));
    const off = api.onLocalProgress((ev: { jobId: string; progress: number; text: string }) => {
      if (ev.jobId !== jobId) return;
      updateTask(task, { progress: ev.progress, label: `Скачиваю «${title}»: ${ev.text}` });
      useLocal.setState(s => ({ busy: { ...s.busy, [id]: { progress: ev.progress, text: ev.text, jobId } } }));
    });
    useLocal.setState(s => ({ busy: { ...s.busy, [id]: { progress: 0, text: 'Начинаю…', jobId } } }));
    try {
      await api.localDownload(jobId, id);
      toast('success', `Нейросеть «${title}» скачана`, { detail: 'Теперь она работает без интернета.' });
      return true;
    } catch (e) {
      const msg = clean(e);
      if (msg !== 'Отменено') toast('error', 'Не удалось скачать нейросеть', { detail: msg, ttl: 12000 });
      return false;
    } finally {
      off();
      endTask(task);
      useLocal.setState(s => { const busy = { ...s.busy }; delete busy[id]; return { busy }; });
      running.delete(id);
      refreshLocal();
    }
  })();
  running.set(id, job);
  return job;
}

/** Есть ли модель на компьютере; если нет — спросить и скачать. why — начало фразы «Чтобы …,» */
export async function ensureModel(id: LocalModelId, why: string): Promise<boolean> {
  if (await modelReady(id)) return true;
  if (running.has(id)) return running.get(id)!;
  const need = left(useLocal.getState().status, id);
  const v = await askConfirm({
    title: 'Скачать нейросеть?', icon: 'download',
    text: `${why} нужна нейросеть «${localModel(id).title}». Она работает прямо на вашем компьютере: без интернета, без ключей и бесплатно. Скачать её нужно один раз — ${mb(need)}.`,
    buttons: [{ label: 'Не сейчас', kind: 'ghost', value: 'no' }, { label: `Скачать (${mb(need)})`, kind: 'primary', value: 'yes' }],
  });
  if (v !== 'yes') return false;
  return downloadModel(id);
}

/** Перед распознаванием речи: если речь распознаётся на компьютере, нужная модель должна быть скачана */
export async function ensureSpeech(language?: string): Promise<boolean> {
  let local = true;
  try { local = await api.speechLocal(); } catch { /* старый главный процесс — считаем, что на компьютере */ }
  if (!local) return true;
  const lang = language || get().settings.ai.speechLanguage;
  return ensureModel(asrModelFor(lang), 'Чтобы распознать речь,');
}

/** Если ошибка говорит, что модель не скачана, — предложить скачать. Возвращает, скачана ли теперь. */
export async function offerMissingModel(e: unknown): Promise<boolean> {
  const id = /\[MODEL:([\w-]+)\]/.exec(clean(e))?.[1] as LocalModelId | undefined;
  if (!id) return false;
  return ensureModel(id, 'Для этого');
}

export async function deleteModel(id: LocalModelId) {
  const v = await askConfirm({
    title: 'Удалить нейросеть?',
    text: `«${localModel(id).title}» удалится с компьютера. Если она снова понадобится, программа предложит скачать её заново.`,
    buttons: [{ label: 'Отмена', kind: 'ghost', value: 'no' }, { label: 'Удалить', kind: 'danger', value: 'yes' }],
  });
  if (v !== 'yes') return;
  useLocal.setState({ status: await api.localDelete(id) });
}

// ── Голос отдельно от музыки ─────────────────────────
export type SeparateMode = 'both' | 'voice' | 'music';
const MODE_LABEL: Record<SeparateMode, string> = { both: 'Голос и музыка разделены', voice: 'Оставлен только голос', music: 'Голос убран, осталась музыка' };

/**
 * Делит звук клипа на голос и всё остальное (музыку, шум улицы). Видео остаётся на месте без звука,
 * а голос и музыка встают на звуковые дорожки — громкость каждой можно менять отдельно.
 */
export async function separateVoice(clipId: string, mode: SeparateMode = 'both', quality?: 'fast' | 'best', source?: string): Promise<string[]> {
  const p0 = get().project!;
  const f = findClip(p0, clipId);
  if (!f || f.clip.type !== 'media') throw new Error('Выберите клип со звуком');
  const c0 = f.clip;
  const m = mediaById(p0, c0.mediaId);
  if (!m?.hasAudio || m.missing) throw new Error('В этом клипе нет звука');
  const q = quality || get().settings.separation || 'best';
  const model: LocalModelId = q === 'fast' ? 'sep-fast' : 'sep-best';
  if (!(await ensureModel(model, 'Чтобы отделить голос от музыки,'))) return [];
  const len = Math.max(0.1, Math.min(c0.out, m.duration || c0.out) - c0.in);
  const jobId = 'sv' + Date.now();
  const task = startTask(`Отделяю голос от музыки${len > 90 ? ` (${Math.round(len / 60)} мин звука)` : ""}`, () => api.separateVoiceCancel(jobId));
  const off = api.onProcessProgress((ev: { jobId: string; progress: number }) => { if (ev.jobId === jobId) updateTask(task, { progress: ev.progress }); });
  let out: { voice: string; music: string };
  try {
    out = await api.separateVoice(jobId, m.path, c0.in, c0.in + len, q);
  } catch (e) {
    const msg = clean(e);
    if (msg !== 'Отменено') toast('error', 'Не удалось отделить голос', { detail: msg, ttl: 12000 });
    throw e;
  } finally {
    off();
    endTask(task);
  }
  const added = await importFiles([out.voice, out.music]);
  const voice = added.find(x => x.path === out.voice), music = added.find(x => x.path === out.music);
  if (!voice || !music) throw new Error('Не удалось добавить звук в проект');
  const ids: string[] = [];
  commit(MODE_LABEL[mode], p => {
    const cf = findClip(p, clipId);
    if (!cf || cf.clip.type !== 'media') return;
    const cc = cf.clip as MediaClip;
    const base = { start: cc.start, in: 0, out: Math.min(len, voice.duration || len), speed: cc.speed, volume: cc.volume, audioFadeIn: cc.audioFadeIn, audioFadeOut: cc.audioFadeOut };
    const vClip = makeMediaClip(voice, { ...base, label: 'Голос', voice: cc.voice, denoise: cc.denoise, eq: cc.eq });
    const mClip = makeMediaClip(music, { ...base, out: Math.min(len, music.duration || len), label: 'Музыка' });
    const put: MediaClip[] = mode === 'both' ? [vClip, mClip] : mode === 'voice' ? [vClip] : [mClip];
    if (cf.track.kind === 'audio' && m.kind === 'audio') {
      // звуковой клип заменяем первым результатом, второй кладём на соседнюю дорожку
      const [first, ...rest] = put;
      const i = cf.track.clips.findIndex(x => x.id === cc.id);
      first.id = cc.id;
      cf.track.clips[i] = first;
      ids.push(first.id);
      for (const r of rest) { trackFor(p, 'audio', r.start, clipDuration(r)).clips.push(r); ids.push(r.id); }
    } else {
      cc.muted = true;
      for (const r of put) { trackFor(p, 'audio', r.start, clipDuration(r)).clips.push(r); ids.push(r.id); }
    }
    return ids;
  }, { source });
  set({ selection: ids.slice(0, 1) });
  toast('success', MODE_LABEL[mode], { detail: mode === 'both' ? 'Голос и музыка теперь на отдельных звуковых дорожках: громкость каждой меняется отдельно.' : 'Новый звук лежит на звуковой дорожке под видео.', ttl: 8000 });
  return ids;
}
