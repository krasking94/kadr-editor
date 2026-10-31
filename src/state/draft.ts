// «Собери ролик сам» (с 0.9): человек выбирает сырые записи и пишет, что хочет получить,
// программа распознаёт речь, нейросеть выбирает лучшие куски и порядок, и на таймлайне появляется черновик.
import { create } from 'zustand';
import { api } from '../api';
import type { MediaClip, MediaItem, TextClip } from '../../shared/types';
import { makeMediaClip, makeTextClip, mainTrack, mediaById, projectDuration } from '../../shared/timeline';
import { DRAFT_SYSTEM, draftInput, draftLength, fallbackDraft, parseDraft, type DraftPlan, type DraftSource } from '../../shared/draft';
import { timelineWords } from '../../shared/transcript';
import { chunkWords } from '../../shared/speech';
import { askConfirm, commit, endTask, get, patchMediaEverywhere, set, startTask, toast, updateTask } from './store';
import { addTrack, BLOGGER_STYLE, setProjectFormat } from './actions';
import { aiReady } from './script';
import { fitMusic } from './studio';
import { HIGHLIGHTS } from './smart';

const clean = (e: unknown) => String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export interface DraftOptions {
  mediaIds: string[];
  request: string;
  target: number; // секунд
  format: 'project' | 'vertical' | 'wide' | 'square';
  subtitles: boolean;
  musicId?: string; // музыка из медиатеки
  title: boolean;
  replace?: boolean; // заменить то, что уже на основной дорожке
  source?: string;
}

interface DraftState { busy: boolean; step: string; plan: DraftPlan | null; usedAi: boolean }
export const useDraft = create<DraftState>(() => ({ busy: false, step: '', plan: null, usedAi: false }));

let cancelled = false;
export function cancelDraft() { cancelled = true; }

/** Распознать речь у файлов, где её ещё нет. Без ключа распознавания — просто пропускаем. */
async function ensureWords(list: MediaItem[]): Promise<boolean> {
  let any = false;
  for (const [i, m] of list.entries()) {
    if (cancelled) throw new Error('Отменено');
    if (m.transcript || !m.hasAudio || m.kind !== 'video') { any = any || !!m.transcript?.words.length; continue; }
    useDraft.setState({ step: `Распознаю речь: ${i + 1} из ${list.length}` });
    const jobId = 'dt' + Date.now() + i;
    const task = startTask(`Распознаю речь (${i + 1} из ${list.length})`, () => api.transcribeMediaCancel(jobId));
    const off = api.onTranscribeProgress((ev: { jobId: string; progress: number }) => { if (ev.jobId === jobId) updateTask(task, { progress: ev.progress }); });
    try {
      const words = await api.transcribeMedia(jobId, m.path, m.duration);
      patchMediaEverywhere(m.id, { transcript: { words, language: get().settings.ai.speechLanguage || undefined, at: Date.now() } });
      any = any || words.length > 0;
    } catch (e) {
      const msg = clean(e);
      if (msg === 'Отменено') throw e;
      toast('warn', 'Речь не распознана — соберу по картинке', { detail: msg, ttl: 8000 });
      return any;
    } finally {
      off();
      endTask(task);
    }
  }
  return any;
}

export async function runDraft(o: DraftOptions): Promise<DraftPlan | null> {
  cancelled = false;
  useDraft.setState({ busy: true, step: 'Смотрю файлы', plan: null });
  try {
    const p0 = get().project!;
    const media = o.mediaIds.map(id => mediaById(p0, id)).filter((m): m is MediaItem => !!m && !m.missing && m.kind !== 'audio');
    if (!media.length) { toast('info', 'Отметьте хотя бы одно видео или фото'); return null; }
    if (mainTrack(p0).clips.length && o.replace === undefined) {
      const v = await askConfirm({ title: 'На таймлайне уже есть монтаж', text: 'Куда поставить черновик?', buttons: [{ label: 'Отмена', kind: 'ghost', value: 'no' }, { label: 'В конец ролика', value: 'add' }, { label: 'Заменить монтаж', kind: 'primary', value: 'replace' }] });
      if (v === 'no') return null;
      o.replace = v === 'replace';
    }
    if (o.format !== 'project') {
      const [w, h] = o.format === 'vertical' ? [1080, 1920] : o.format === 'square' ? [1080, 1080] : [1920, 1080];
      if (p0.width !== w || p0.height !== h) setProjectFormat(w, h);
    }
    await ensureWords(media);
    const pr = get().project!;
    const fresh = media.map(m => mediaById(pr, m.id)!);
    // где меняется картинка — для видео без речи
    const sources: DraftSource[] = [];
    for (const m of fresh) {
      if (cancelled) throw new Error('Отменено');
      let shots: number[] | undefined;
      if (m.kind === 'video' && !m.transcript?.words.length) {
        useDraft.setState({ step: `Ищу сцены: ${m.name}` });
        shots = await api.scenes(m.path, 0, m.duration, 0.35).catch(() => []);
      }
      sources.push({ media: m, words: m.transcript?.words, shots });
    }
    const vertical = (get().project!.height > get().project!.width);
    let plan: DraftPlan;
    let usedAi = false;
    if (aiReady()) {
      useDraft.setState({ step: 'Нейросеть выбирает лучшие куски' });
      const task = startTask('Нейросеть собирает черновик');
      try {
        const reply: string = await api.aiComplete(DRAFT_SYSTEM(o.target, vertical), draftInput(o.request, sources));
        plan = parseDraft(reply, sources);
        usedAi = true;
      } catch (e) {
        if (cancelled) throw new Error('Отменено');
        toast('warn', 'Нейросеть не справилась — соберу по простому правилу', { detail: clean(e), ttl: 8000 });
        plan = fallbackDraft(sources, o.target);
      } finally {
        endTask(task);
      }
    } else {
      toast('info', 'Нейросеть не подключена — соберу по простому правилу', { detail: 'С нейросетью черновик получится умнее: Настройки → Нейросети.', ttl: 8000 });
      plan = fallbackDraft(sources, o.target);
    }
    if (cancelled) throw new Error('Отменено');
    if (!plan.pieces.length) { toast('info', 'Не из чего собрать черновик'); return null; }
    applyDraft(plan, sources, o);
    useDraft.setState({ plan, usedAi });
    return plan;
  } catch (e) {
    const msg = clean(e);
    if (msg !== 'Отменено') toast('error', 'Не удалось собрать черновик', { detail: msg });
    return null;
  } finally {
    useDraft.setState({ busy: false, step: '' });
  }
}

function applyDraft(plan: DraftPlan, sources: DraftSource[], o: DraftOptions) {
  let startAt = 0;
  const ids: string[] = [];
  commit(`Черновик ролика: ${plan.pieces.length} кусков`, p => {
    const main = mainTrack(p);
    if (o.replace) {
      main.clips = [];
      for (const t of p.tracks) if (t.kind === 'text') t.clips = t.clips.filter(c => !(c.type === 'text' && c.subtitle));
    }
    startAt = projectDuration({ ...p, tracks: [main] });
    let prevFile = -1;
    for (const piece of plan.pieces) {
      const m = sources[piece.file].media;
      const c: MediaClip = makeMediaClip(m, { in: m.kind === 'image' ? 0 : piece.start, out: piece.end, fit: 'fill' });
      if (m.kind === 'image') {
        // фото «оживают» лёгким приближением
        c.animate = true;
        c.transformEnd = { ...c.transform, scale: 1.12 };
      }
      // между разными файлами — короткий мягкий переход, внутри одного файла — прямая склейка
      if (main.clips.length && prevFile !== piece.file) c.transition = { type: 'dissolve', duration: 0.3 };
      main.clips.push(c);
      ids.push(c.id);
      prevFile = piece.file;
    }
    return ids;
  }, { source: o.source });
  const p = get().project!;
  const end = projectDuration({ ...p, tracks: [mainTrack(p)] });
  // субтитры по словам — из уже распознанной речи, без повторной отправки в сервис
  if (o.subtitles) {
    const words = timelineWords(p).filter(w => w.s >= startAt - 0.05);
    if (words.length) {
      commit('Субтитры к черновику', pr => {
        const t = addTrack(pr, 'text');
        t.name = 'Субтитры';
        const vertical = pr.height > pr.width;
        for (const ch of chunkWords(words, 3)) {
          const c: TextClip = makeTextClip(ch.text, ch.start, Math.max(0.3, ch.end - ch.start), { ...BLOGGER_STYLE, size: vertical ? 82 : 70, y: vertical ? 0.68 : 0.8 });
          c.subtitle = true; c.animIn = 'none'; c.animOut = 'none';
          c.words = ch.words; c.highlight = HIGHLIGHTS[0];
          t.clips.push(c);
        }
      }, { source: o.source, quiet: true });
    }
  }
  if (o.title && plan.title) {
    // заголовок крупно в первые секунды — как в коротких роликах
    commit('Заголовок черновика', pr => {
      const tall = pr.height > pr.width;
      const t = addTrack(pr, 'text');
      t.name = 'Заголовок';
      const c = makeTextClip(plan.title, startAt, Math.min(3.5, Math.max(1, end - startAt)), {
        font: 'Unbounded', size: tall ? 56 : 64, bold: true, y: tall ? 0.16 : 0.13, background: true, backgroundColor: '#000000', backgroundOpacity: 0.7, shadow: false, maxWidth: 0.86,
      });
      c.animIn = 'zoom'; c.animOut = 'fade';
      t.clips.push(c);
      return [c.id];
    }, { source: o.source, quiet: true });
  }
  if (o.musicId && mediaById(p, o.musicId)) {
    let musicClip = '';
    commit('Музыка к черновику', pr => {
      const m = mediaById(pr, o.musicId!)!;
      const c = makeMediaClip(m, { start: startAt, out: Math.min(m.duration, end - startAt), volume: 0.35, duck: true, audioFadeOut: 1.5 });
      const t = pr.tracks.find(x => x.kind === 'audio' && !x.locked && x.clips.every(k => k.start >= end || k.start + (k.type === 'media' ? (k.out - k.in) / k.speed : k.duration) <= startAt)) || addTrack(pr, 'audio');
      t.clips.push(c);
      t.clips.sort((a, b) => a.start - b.start);
      musicClip = c.id;
      return [c.id];
    }, { source: o.source, quiet: true });
    if (musicClip) fitMusic(musicClip, { source: o.source }).catch(() => undefined);
  }
  set({ playhead: startAt, playing: false, selection: ids });
  if (!o.source || o.source === 'user') toast('success', `Черновик готов: ${Math.round(draftLength(plan))} с`, { detail: 'Посмотрите и поправьте: куски можно двигать, укорачивать и удалять. Ctrl+Z — убрать черновик.', ttl: 10000 });
}
