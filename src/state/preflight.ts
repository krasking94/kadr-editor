// Проверка перед публикацией (с 0.9): сначала смотрим проект (надписи, музыка, пустоты),
// потом быстро «прогоняем» весь ролик в маленьком размере и слушаем громкость, тишину и чёрные куски.
import { create } from 'zustand';
import { api } from '../api';
import type { MediaClip, TextClip } from '../../shared/types';
import { clipEnd, findClip, mainTrack, projectDuration } from '../../shared/timeline';
import { analysisIssues, sortIssues, staticChecks, textInside, type Issue, type TextBox } from '../../shared/preflight';
import { drawText } from '../lib/text-render';
import { loadFonts } from '../lib/fonts';
import { commit, get, set } from './store';
import { projectForRender, relinkMedia, textRenders, updateMediaClip, updateTextClip } from './actions';
import { saveSettings } from './settings-actions';

const clean = (e: unknown) => String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

interface PreflightState {
  busy: boolean;
  progress: number;
  issues: Issue[] | null;
  analyzed: boolean; // ролик «просмотрен» целиком (а не только проект)
  error: string;
  at: number; // когда проверяли
  lufs?: number;
}
export const usePreflight = create<PreflightState>(() => ({ busy: false, progress: 0, issues: null, analyzed: false, error: '', at: 0 }));

let jobId = '';

/** Рамки всех надписей в кадре — чтобы понять, не обрезаны ли они */
async function textBoxes(): Promise<TextBox[]> {
  await loadFonts();
  const p = get().project!;
  const H = 540, W = Math.round((H * p.width) / p.height);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d')!;
  const out: TextBox[] = [];
  for (const t of p.tracks) {
    if (t.kind !== 'text' || t.hidden) continue;
    for (const c of t.clips) {
      if (c.type !== 'text' || !c.text.trim()) continue;
      ctx.clearRect(0, 0, W, H);
      const b = drawText(ctx, c, W, H);
      out.push({ clipId: c.id, x: b.x / W, y: b.y / H, w: b.w / W, h: b.h / H });
    }
  }
  return out;
}

const generatedDir = () => {
  const d = get().info?.documentsDir;
  return d ? `${d}/Хлопушка/Сгенерировано` : undefined;
};

/** Проверить ролик. deep — ещё и «просмотреть» его целиком (занимает от нескольких секунд до минуты). */
export async function runPreflight(o: { deep?: boolean } = {}): Promise<Issue[]> {
  const deep = o.deep !== false;
  usePreflight.setState({ busy: true, progress: 0, error: '', analyzed: false });
  try {
    const p = get().project!;
    let issues = staticChecks(p, await textBoxes(), { generatedDir: generatedDir() });
    usePreflight.setState({ issues: sortIssues(issues) });
    let lufs: number | undefined;
    if (deep && projectDuration(p) > 0) {
      const part = projectForRender(p);
      jobId = 'pf' + Date.now();
      const off = api.onProcessProgress((ev: { jobId: string; progress: number }) => { if (ev.jobId === jobId) usePreflight.setState({ progress: ev.progress }); });
      try {
        const a = await api.preflight(jobId, part, await textRenders(part));
        lufs = isFinite(a.lufs) ? a.lufs : undefined;
        const target = get().settings.loudness || -14;
        // если громкость и так выравнивается при сохранении — о тихом звуке не говорим
        const levelled = !!get().settings.loudness;
        issues = [...issues, ...analysisIssues(a, projectDuration(p), target).filter(i => !(levelled && ['quiet', 'loud', 'peak'].includes(i.id)))];
      } finally {
        off();
      }
    }
    const sorted = sortIssues(issues);
    usePreflight.setState({ issues: sorted, analyzed: deep, at: Date.now(), lufs });
    return sorted;
  } catch (e) {
    const msg = clean(e);
    usePreflight.setState({ error: msg === 'Отменено' ? '' : msg });
    throw new Error(msg);
  } finally {
    usePreflight.setState({ busy: false });
  }
}

export function cancelPreflight() {
  if (jobId) api.exportCancel(jobId);
}

/** Исправить одной кнопкой то, что можно исправить автоматически */
export async function fixIssue(issue: Issue): Promise<void> {
  const p = get().project!;
  switch (issue.fix?.kind) {
    case 'loudness':
      await saveSettings({ loudness: -14 });
      break;
    case 'fade-music':
      if (issue.clipId) updateMediaClip(issue.clipId, { audioFadeOut: 2 }, 'Музыка плавно затихает', { coalesce: '' });
      break;
    case 'move-text': {
      const f = issue.clipId ? findClip(p, issue.clipId) : null;
      if (!f || f.clip.type !== 'text') break;
      const box = (await textBoxes()).find(b => b.clipId === issue.clipId);
      if (!box) break;
      const pos = textInside(f.clip as TextClip, box, p.height > p.width);
      updateTextClip(f.clip.id, { style: pos }, 'Надпись подвинута в кадр', { coalesce: '' });
      break;
    }
    case 'relink': {
      const id = issue.id.split(':')[1];
      if (id) await relinkMedia(id);
      break;
    }
    case 'extend-main': {
      // всё, что дольше видео, обрезаем по концу видео
      const main = mainTrack(p);
      const end = Math.max(main.clips.reduce((e, c) => Math.max(e, clipEnd(c)), 0),
        ...p.tracks.filter(t => t.kind === 'video').flatMap(t => t.clips).map(c => clipEnd(c)));
      commit('Ролик обрезан по видео', pr => {
        for (const t of pr.tracks) {
          if (t.kind === 'main' || t.kind === 'video') continue;
          t.clips = t.clips.filter(c => c.start < end - 0.1);
          for (const c of t.clips) {
            if (clipEnd(c) <= end) continue;
            if (c.type === 'text') c.duration = end - c.start;
            else { const mc = c as MediaClip; mc.out = mc.in + (end - mc.start) * mc.speed; mc.audioFadeOut = Math.max(mc.audioFadeOut, 1.5); }
          }
        }
      });
      break;
    }
    case 'subs-overlap':
      commit('Субтитры подровнены', pr => {
        for (const t of pr.tracks) {
          if (t.kind !== 'text') continue;
          const subs = t.clips.filter((c): c is TextClip => c.type === 'text' && !!c.subtitle).sort((a, b) => a.start - b.start);
          for (let i = 0; i < subs.length - 1; i++) {
            const lim = subs[i + 1].start - subs[i].start;
            if (subs[i].duration > lim) subs[i].duration = Math.max(0.2, lim);
          }
        }
      });
      break;
  }
  // убираем исправленное из списка
  usePreflight.setState(s => ({ issues: s.issues?.filter(i => i.id !== issue.id && !(issue.fix?.kind === 'loudness' && ['quiet', 'loud', 'peak'].includes(i.id))) ?? null }));
}

export const showIssue = (i: Issue) => {
  if (i.time !== undefined) set({ playhead: i.time, playing: false });
  if (i.clipId) set({ selection: [i.clipId] });
};
