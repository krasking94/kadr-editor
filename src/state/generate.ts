// Создание картинок, голоса, звуков и музыки нейросетями и укладка результата на таймлайн.
// Этим пользуются и панель «Создать», и ИИ (встроенный помощник и внешний по MCP).
import { api } from '../api';
import { ASPECTS, type Aspect, type GenResult } from '../../shared/generators';
import { projectDuration } from '../../shared/timeline';
import type { MediaItem } from '../../shared/types';
import * as A from './actions';
import { endTask, get, startTask, toast, updateTask } from './store';

export type GenKind = 'image' | 'speech' | 'sfx' | 'music' | 'video';

export interface GenRequest {
  kind: GenKind;
  prompt: string;
  aspect?: Aspect;
  place?: 'main' | 'overlay' | 'audio' | 'none';
  index?: number;
  start?: number;
  duration?: number;
  animate?: boolean;
  voiceId?: string;
  vocals?: boolean;
  volume?: number;
  image?: string; // для ИИ-видео: оживить эту картинку
}

export interface GenOutcome { media: MediaItem; clipId: string | null; duration: number; path: string }

const LABEL: Record<GenKind, { task: string; done: string }> = {
  image: { task: 'Рисую картинку', done: 'Картинка готова' },
  speech: { task: 'Озвучиваю текст', done: 'Озвучка готова' },
  sfx: { task: 'Создаю звук', done: 'Звук готов' },
  music: { task: 'Пишу музыку', done: 'Музыка готова' },
  video: { task: 'Нейросеть снимает видео', done: 'Видео готово' },
};

export const cleanError = (e: unknown) => String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** Пропорции кадра проекта, ближайшие из тех, что умеют нейросети */
export function projectAspect(): Aspect {
  const p = get().project;
  if (!p) return '16:9';
  const r = p.width / p.height;
  const val = (a: string) => { const [w, h] = a.split(':').map(Number); return w / h; };
  return [...ASPECTS].sort((a, b) => Math.abs(Math.log(val(a) / r)) - Math.abs(Math.log(val(b) / r)))[0];
}

export async function generate(req: GenRequest, source = 'user'): Promise<GenOutcome> {
  const s = get();
  if (!s.project) throw new Error('Сначала откройте или создайте проект');
  const short = req.prompt.length > 40 ? req.prompt.slice(0, 40) + '…' : req.prompt;
  const jobId = 'v' + Date.now();
  const title = `${LABEL[req.kind].task}: «${short || 'оживляю фото'}»`;
  const task = startTask(title, req.kind === 'video' ? () => api.genVideoCancel(jobId) : undefined);
  const off = req.kind === 'video' ? api.onGenVideoStatus((ev: { jobId: string; text: string }) => { if (ev.jobId === jobId) updateTask(task, { label: `${title} · ${ev.text}` }); }) : null;
  let res: GenResult;
  try {
    if (req.kind === 'video') {
      res = await api.genVideo(jobId, req.prompt, { image: req.image, aspect: req.aspect || projectAspect(), duration: req.duration });
    } else if (req.kind === 'image') {
      const aspect = req.aspect || (s.settings.gen.imageAspect !== 'auto' ? s.settings.gen.imageAspect as Aspect : projectAspect());
      res = await api.genImage(req.prompt, aspect);
    } else if (req.kind === 'speech') res = await api.genSpeech(req.prompt, req.voiceId);
    else if (req.kind === 'sfx') res = await api.genSfx(req.prompt, req.duration);
    else {
      const dur = req.duration || Math.max(10, Math.ceil(projectDuration(s.project)));
      res = await api.genMusic(req.prompt, dur, !req.vocals);
    }
  } catch (e) {
    throw new Error(cleanError(e));
  } finally {
    off?.();
    endTask(task);
  }
  const [media] = await A.importFiles([res.path], { source });
  if (!media) throw new Error('Файл создан, но не открылся: ' + res.path);

  let clipId: string | null = null;
  const place = req.place ?? (req.kind === 'image' || req.kind === 'video' ? 'main' : 'audio');
  if (place !== 'none') {
    if (media.kind === 'video') {
      clipId = A.addToTimeline(media.id, place === 'overlay' ? 'overlay' : 'main', { index: req.index, start: req.start, source, patch: place === 'main' ? { fit: 'fill' } : {}, label: `ИИ-видео «${short || 'оживлённое фото'}»` });
    } else if (media.kind === 'image') {
      const dur = Math.max(0.5, req.duration ?? 4);
      const onMain = place === 'main';
      const zoom = req.animate ?? onMain;
      clipId = A.addToTimeline(media.id, onMain ? 'main' : 'overlay', {
        index: req.index, start: req.start, out: dur, source,
        patch: onMain ? { fit: 'fill', ...(zoom ? { animate: true, transformEnd: { x: 0.5, y: 0.5, scale: 1.12, rotation: 0, opacity: 1 } } : {}) } : {},
        label: `Создана картинка «${short}»`,
      });
    } else {
      const music = req.kind === 'music';
      clipId = A.addToTimeline(media.id, 'audio', {
        start: req.start ?? (music ? 0 : get().playhead), source,
        patch: music ? { volume: req.volume ?? 0.35, duck: true, audioFadeIn: 1, audioFadeOut: 2 } : req.volume !== undefined ? { volume: req.volume } : {},
        label: `${LABEL[req.kind].done}: «${short}»`,
      });
    }
  }
  if (source === 'user') toast('success', LABEL[req.kind].done, { detail: clipId ? 'Уже на таймлайне. Отменить — Ctrl+Z' : 'Лежит в медиатеке' });
  return { media, clipId, duration: media.kind === 'image' ? (req.duration ?? 4) : media.duration, path: res.path };
}

/** Картинка для «оживить фото»: выбранное фото на таймлайне или текущий кадр ролика */
export async function videoSourceImage(): Promise<{ path: string; label: string } | null> {
  const s = get();
  const p = s.project!;
  for (const id of s.selection) {
    for (const t of p.tracks) for (const c of t.clips) {
      if (c.id !== id || c.type !== 'media') continue;
      const m = p.media.find(x => x.id === c.mediaId);
      if (m?.kind === 'image' && !m.missing) return { path: m.path, label: m.name };
    }
  }
  if (projectDuration(p) <= 0) return null;
  const b64 = await A.renderFrame(s.playhead, 1280);
  const path = await api.saveImage('data:image/jpeg;base64,' + b64, `Кадр для ИИ-видео ${Date.now()}`);
  return { path, label: 'кадр под курсором' };
}
