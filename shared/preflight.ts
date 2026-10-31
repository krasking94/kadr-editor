// Проверка перед публикацией: программа сама ищет то, за что ролик могут не досмотреть,
// заглушить или заблокировать. Здесь — проверки по проекту и разбор ответа FFmpeg.
import type { MediaClip, Project, TextClip } from './types';
import { clipDuration, clipEnd, layoutProject, mainTrack, projectDuration } from './timeline';

export type IssueLevel = 'error' | 'warn' | 'info';
export type FixKind = 'loudness' | 'fade-music' | 'move-text' | 'relink' | 'extend-main' | 'subs-overlap';

export interface Issue {
  id: string;
  level: IssueLevel;
  title: string;
  detail: string;
  time?: number; // где посмотреть
  clipId?: string;
  fix?: { kind: FixKind; label: string };
}

export interface TextBox { clipId: string; x: number; y: number; w: number; h: number } // рамка надписи в долях кадра

/** Где интерфейс соцсети закрывает вертикальное видео: подписи и кнопки снизу и справа */
export const VERTICAL_SAFE = { top: 0.1, bottom: 0.2, left: 0.04, right: 0.14 };

/** Проверки, которым не нужно смотреть видео: только сам проект */
export function staticChecks(p0: Project, boxes: TextBox[] = [], o: { generatedDir?: string } = {}): Issue[] {
  const p: Project = structuredClone(p0);
  layoutProject(p);
  const out: Issue[] = [];
  const total = projectDuration(p);
  if (total <= 0) return [{ id: 'empty', level: 'error', title: 'Ролик пустой', detail: 'Добавьте видео, фото или текст на таймлайн.' }];

  const missing = p.media.filter(m => m.missing && p.tracks.some(t => t.clips.some(c => c.type === 'media' && c.mediaId === m.id)));
  for (const m of missing) out.push({ id: 'missing:' + m.id, level: 'error', title: `Файл не найден: ${m.name}`, detail: 'В готовом видео на этом месте будет пусто. Укажите, где файл теперь лежит.', fix: { kind: 'relink', label: 'Найти файл' } });

  // конец ролика без картинки: музыка или надпись идут дальше основного видео
  const main = mainTrack(p);
  const mainEnd = main.clips.reduce((e, c) => Math.max(e, clipEnd(c)), 0);
  const overlayEnd = p.tracks.filter(t => t.kind === 'video' && !t.hidden).flatMap(t => t.clips).reduce((e, c) => Math.max(e, clipEnd(c)), 0);
  const picEnd = Math.max(mainEnd, overlayEnd);
  if (main.clips.length && total - picEnd > 0.5) {
    out.push({ id: 'black-end', level: 'warn', title: `В конце ${(total - picEnd).toFixed(1)} с чёрного экрана`, detail: 'Звук или надпись длиннее видео. Зритель уходит, когда экран чёрный.', time: picEnd, fix: { kind: 'extend-main', label: 'Обрезать по видео' } });
  }

  // очень короткие клипы выглядят как мигание
  for (const c of main.clips) {
    const d = clipDuration(c);
    if (d < 0.25) out.push({ id: 'short:' + c.id, level: 'info', title: `Очень короткий кусок: ${d.toFixed(2)} с`, detail: 'Похоже на случайный остаток после разреза — на экране это мигание.', time: c.start, clipId: c.id });
  }

  // музыка обрывается на последнем кадре
  for (const t of p.tracks) {
    if (t.kind !== 'audio' || t.muted) continue;
    for (const c of t.clips) {
      if (c.type !== 'media' || c.muted) continue;
      if (Math.abs(clipEnd(c) - total) < 0.3 && c.audioFadeOut < 0.5 && clipDuration(c) > 5) {
        out.push({ id: 'cut-music:' + c.id, level: 'warn', title: 'Музыка обрывается на последнем кадре', detail: 'Резкий обрыв звучит как ошибка. Лучше плавно затихнуть за 1–2 секунды.', time: Math.max(0, total - 2), clipId: c.id, fix: { kind: 'fade-music', label: 'Сделать плавный конец' } });
      }
    }
  }

  // чужая музыка: программа не знает, откуда трек, но предупреждает о правах
  const music = new Set<string>();
  for (const t of p.tracks) if (t.kind === 'audio') for (const c of t.clips) if (c.type === 'media') music.add(c.mediaId);
  for (const id of music) {
    const m = p.media.find(x => x.id === id);
    if (!m || m.kind !== 'audio') continue;
    const ours = o.generatedDir && m.path.replace(/\\/g, '/').startsWith(o.generatedDir.replace(/\\/g, '/'));
    if (ours) continue;
    out.push({ id: 'rights:' + id, level: 'info', title: `Права на музыку: ${m.name}`, detail: 'Если это песня известного исполнителя, YouTube и ВК могут заглушить звук или убрать рекламу. Безопасно: фонотека YouTube, треки с лицензией или музыка, созданная в «Хлопушке».' });
  }

  // надписи за краем кадра и под кнопками соцсетей
  const vertical = p.height > p.width;
  const texts = new Map<string, TextClip>();
  for (const t of p.tracks) if (t.kind === 'text' && !t.hidden) for (const c of t.clips) if (c.type === 'text') texts.set(c.id, c);
  for (const b of boxes) {
    const c = texts.get(b.clipId);
    if (!c) continue;
    const name = `«${c.text.split('\n')[0].slice(0, 30)}»`;
    if (b.x < -0.005 || b.y < -0.005 || b.x + b.w > 1.005 || b.y + b.h > 1.005) {
      out.push({ id: 'cut-text:' + c.id, level: 'error', title: `Надпись обрезана краем кадра: ${name}`, detail: 'Часть текста не попадёт в видео.', time: c.start + Math.min(0.5, c.duration / 2), clipId: c.id, fix: { kind: 'move-text', label: 'Подвинуть в кадр' } });
    } else if (vertical && !c.subtitle && (b.y + b.h > 1 - VERTICAL_SAFE.bottom || b.x + b.w > 1 - VERTICAL_SAFE.right || b.y < VERTICAL_SAFE.top)) {
      out.push({ id: 'safe-text:' + c.id, level: 'warn', title: `Надпись под кнопками соцсети: ${name}`, detail: 'В Reels, Shorts и TikTok сверху, снизу и справа лежат кнопки и подпись — текст там не прочитают.', time: c.start + Math.min(0.5, c.duration / 2), clipId: c.id, fix: { kind: 'move-text', label: 'Подвинуть в безопасную зону' } });
    }
  }

  // субтитры налезают друг на друга
  for (const t of p.tracks) {
    if (t.kind !== 'text') continue;
    const subs = t.clips.filter((c): c is TextClip => c.type === 'text' && !!c.subtitle).sort((a, b) => a.start - b.start);
    let overlaps = 0, at = 0;
    for (let i = 1; i < subs.length; i++) if (subs[i].start < subs[i - 1].start + subs[i - 1].duration - 0.05) { if (!overlaps) at = subs[i].start; overlaps++; }
    if (overlaps) out.push({ id: 'subs:' + t.id, level: 'warn', title: `Субтитры налезают друг на друга: ${overlaps}`, detail: 'Две строки на экране одновременно читать трудно.', time: at, fix: { kind: 'subs-overlap', label: 'Подровнять' } });
  }
  return out;
}

/** Куда подвинуть надпись, чтобы её рамка встала в кадр (и в безопасную зону вертикального ролика) */
export function textInside(c: TextClip, b: TextBox, vertical: boolean): { x: number; y: number; maxWidth?: number } {
  const z = vertical ? VERTICAL_SAFE : { top: 0.04, bottom: 0.04, left: 0.04, right: 0.04 };
  const room = 1 - z.left - z.right;
  let maxWidth: number | undefined;
  if (b.w > room) maxWidth = Math.max(0.3, Math.min(c.style.maxWidth, room * 0.95));
  const w = Math.min(b.w, room);
  const cx = Math.max(z.left + w / 2, Math.min(1 - z.right - w / 2, b.x + b.w / 2));
  const cy = Math.max(z.top + b.h / 2, Math.min(1 - z.bottom - b.h / 2, b.y + b.h / 2));
  // рамка может стоять не ровно по центру точки текста (выравнивание влево/вправо), поэтому двигаем на разницу
  const x = c.style.x + (cx - (b.x + b.w / 2));
  const y = c.style.y + (cy - (b.y + b.h / 2));
  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)), ...(maxWidth ? { maxWidth } : {}) };
}

export interface Analysis {
  lufs: number; peak: number; // средняя громкость и пик
  silences: { start: number; end: number }[];
  blacks: { start: number; end: number }[];
  freezes: { start: number; end: number }[];
}

/** Разбор отчёта FFmpeg: blackdetect, freezedetect, silencedetect и ebur128 */
export function parseAnalysis(stderr: string, total: number): Analysis {
  const num = (re: RegExp, s: string) => { const m = s.match(re); return m ? Number(m[1]) : NaN; };
  const pairs = (startRe: RegExp, endRe: RegExp) => {
    const out: { start: number; end: number }[] = [];
    const starts = [...stderr.matchAll(startRe)].map(m => Number(m[1]));
    const ends = [...stderr.matchAll(endRe)].map(m => Number(m[1]));
    starts.forEach((s, i) => out.push({ start: s, end: isFinite(ends[i]) ? ends[i] : total }));
    return out;
  };
  const blacks = [...stderr.matchAll(/black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)/g)].map(m => ({ start: Number(m[1]), end: Number(m[2]) }));
  const tail = stderr.slice(stderr.lastIndexOf('Summary:'));
  return {
    lufs: num(/I:\s+(-?[\d.]+) LUFS/, tail), peak: num(/Peak:\s+(-?[\d.]+) dBFS/, tail),
    silences: pairs(/silence_start:\s*(-?[\d.]+)/g, /silence_end:\s*([\d.]+)/g).map(r => ({ start: Math.max(0, r.start), end: r.end })),
    blacks,
    freezes: pairs(/freeze_start:\s*([\d.]+)/g, /freeze_end:\s*([\d.]+)/g),
  };
}

/** Что сказать по результатам просмотра готового ролика */
export function analysisIssues(a: Analysis, total: number, targetLufs = -14): Issue[] {
  const out: Issue[] = [];
  if (isFinite(a.lufs)) {
    if (a.lufs < -60) out.push({ id: 'no-sound', level: 'warn', title: 'В ролике нет звука', detail: 'Если так и задумано — всё в порядке. Иначе проверьте, не выключены ли дорожки.' });
    else if (a.lufs < targetLufs - 4) out.push({ id: 'quiet', level: 'warn', title: `Ролик тихий: ${a.lufs.toFixed(1)} LUFS`, detail: `Площадки ждут около ${targetLufs} LUFS. Тихое видео зритель пролистывает — его плохо слышно на телефоне.`, fix: { kind: 'loudness', label: `Выровнять до ${targetLufs} при сохранении` } });
    else if (a.lufs > targetLufs + 3) out.push({ id: 'loud', level: 'warn', title: `Ролик слишком громкий: ${a.lufs.toFixed(1)} LUFS`, detail: 'YouTube и ВК сами сделают его тише, и звук может стать «плоским».', fix: { kind: 'loudness', label: `Выровнять до ${targetLufs} при сохранении` } });
    if (isFinite(a.peak) && a.peak > -0.5) out.push({ id: 'peak', level: 'warn', title: 'Звук перегружен (хрипит на пиках)', detail: `Пик ${a.peak.toFixed(1)} дБ. Выравнивание громкости при сохранении уберёт хрип.`, fix: { kind: 'loudness', label: 'Включить выравнивание' } });
  }
  for (const s of a.silences) {
    if (s.end - s.start < 3) continue;
    if (s.start > total - 1) continue;
    out.push({ id: `silence:${s.start}`, level: 'warn', title: `Тишина ${(s.end - s.start).toFixed(1)} с`, detail: 'Долгая пауза без звука — частое место, где зрители уходят.', time: s.start });
  }
  for (const b of a.blacks) {
    if (b.start < 0.3 && b.end < 1.2) continue; // плавное появление в самом начале — это нормально
    if (b.end > total - 0.3 && b.end - b.start < 1.5) continue; // и затемнение в конце
    out.push({ id: `black:${b.start}`, level: b.end - b.start > 1 ? 'warn' : 'info', title: `Чёрный экран ${(b.end - b.start).toFixed(1)} с`, detail: 'Похоже на пропуск между клипами или забытый пустой кусок.', time: b.start });
  }
  for (const f of a.freezes) {
    if (f.end - f.start < 4) continue;
    out.push({ id: `freeze:${f.start}`, level: 'info', title: `Картинка не меняется ${(f.end - f.start).toFixed(0)} с`, detail: 'Если это не фото и не заставка — возможно, видео «зависло». Можно оживить движением или нарезкой.', time: f.start });
  }
  return out;
}

export const LEVEL_ORDER: Record<IssueLevel, number> = { error: 0, warn: 1, info: 2 };
export const sortIssues = (list: Issue[]) => [...list].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || (a.time ?? 0) - (b.time ?? 0));

// Музыкальные клипы, которые можно «затушить» исправлением
export const fadeTargets = (p: Project) => p.tracks.filter(t => t.kind === 'audio').flatMap(t => t.clips).filter((c): c is MediaClip => c.type === 'media');
