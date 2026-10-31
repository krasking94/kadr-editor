// Функции версии 0.7: корректирующий слой, автоцвет, размытие лиц, подгонка музыки под длину ролика.
// Как и остальные действия, их вызывают кнопки, ИИ-помощник и внешний ИИ по MCP.
import { api, mediaUrl } from '../api';
import type { MediaClip, Project, TextAnim, TextStyle } from '../../shared/types';
import { clipDuration, clipEnd, findClip, makeMediaClip, makeTextClip, mediaById, projectDuration, uid } from '../../shared/timeline';
import { defaultBrand, type Brand } from '../../shared/settings';
import { padBox } from '../../shared/look';
import { commit, endTask, get, set, startTask, toast, updateTask } from './store';
import { addTrack, importFiles, updateMediaClip } from './actions';
import { faceBoxes, faceDetector } from '../lib/face-track';

const clean = (e: unknown) => String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// ── Корректирующий слой ──────────────────────────────
let adjustPath: string | null = null;

/** Прозрачная картинка, к которой «привязан» корректирующий слой (своего изображения у него нет) */
async function adjustMedia(): Promise<string> {
  const p = get().project!;
  const have = p.media.find(m => m.name === 'Корректирующий слой.png' && !m.missing);
  if (have) return have.id;
  if (!adjustPath) {
    const cv = document.createElement('canvas');
    cv.width = 16; cv.height = 16;
    adjustPath = await api.saveImage(cv.toDataURL('image/png'), 'Корректирующий слой');
  }
  const [m] = await importFiles([adjustPath!]);
  if (!m) throw new Error('Не удалось создать корректирующий слой');
  return m.id;
}

export async function addAdjustLayer(o: { start?: number; duration?: number; source?: string; patch?: Partial<MediaClip> } = {}): Promise<string> {
  const mediaId = await adjustMedia();
  const p = get().project!;
  const m = mediaById(p, mediaId)!;
  const total = projectDuration(p);
  const start = Math.max(0, o.start ?? (get().selection.length ? get().playhead : 0));
  const duration = Math.max(0.2, o.duration ?? (total > start + 0.5 ? total - start : 5));
  const c = makeMediaClip(m, { start, out: duration, adjust: true, label: 'Корректирующий слой', ...o.patch });
  commit('Корректирующий слой', pr => {
    // слой должен лежать выше всех наложений, иначе он не покрасит верхние
    const tracks = pr.tracks.filter(t => t.kind === 'video');
    const top = tracks[tracks.length - 1];
    const free = top && !top.locked && top.clips.every(x => clipEnd(x) <= start + 1e-3 || x.start >= start + duration - 1e-3);
    const t = free ? top : addTrack(pr, 'video');
    if (!free) t.name = 'Коррекция';
    t.clips.push(c);
    t.clips.sort((a, b) => a.start - b.start);
    return [c.id];
  }, { source: o.source });
  set({ selection: [c.id], inspectorTab: 'color' });
  return c.id;
}

// ── Автоцвет ─────────────────────────────────────────
async function grabSource(path: string, kind: 'video' | 'image', t: number): Promise<ImageData> {
  const W = 192;
  let src: HTMLVideoElement | HTMLImageElement;
  if (kind === 'image') {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = mediaUrl(path);
    await img.decode();
    src = img;
  } else {
    const v = document.createElement('video');
    v.muted = true; v.crossOrigin = 'anonymous'; v.preload = 'auto'; v.src = mediaUrl(path);
    await new Promise<void>((res, rej) => { v.addEventListener('loadeddata', () => res(), { once: true }); v.addEventListener('error', () => rej(new Error('Видео не открылось')), { once: true }); });
    await new Promise<void>(res => { v.addEventListener('seeked', () => res(), { once: true }); v.currentTime = Math.max(0, Math.min(t, (v.duration || t) - 0.05)); });
    src = v;
  }
  const sw = src instanceof HTMLVideoElement ? src.videoWidth : src.naturalWidth, sh = src instanceof HTMLVideoElement ? src.videoHeight : src.naturalHeight;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = Math.max(2, Math.round((W * sh) / Math.max(1, sw)));
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, cv.width, cv.height);
  if (src instanceof HTMLVideoElement) { src.removeAttribute('src'); src.load(); }
  return ctx.getImageData(0, 0, cv.width, cv.height);
}

/** Что поменять, чтобы кадр стал «правильным»: тени чёрные, света белые, без цветного оттенка */
export function autoColorFor(img: ImageData): { brightness: number; contrast: number; saturation: number; temperature: number } {
  const d = img.data, n = d.length / 4;
  const lum: number[] = [];
  let r = 0, g = 0, b = 0, mid = 0, sat = 0;
  for (let i = 0; i < d.length; i += 4) {
    const L = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
    lum.push(L);
    const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
    sat += (mx - mn) / 255;
    if (L > 0.15 && L < 0.85) { r += d[i]; g += d[i + 1]; b += d[i + 2]; mid++; }
  }
  lum.sort((x, y) => x - y);
  const q = (k: number) => lum[Math.min(n - 1, Math.max(0, Math.round(k * (n - 1))))];
  const lo = q(0.01), hi = q(0.99), med = q(0.5);
  const contrast = Math.max(0.85, Math.min(1.45, 0.92 / Math.max(0.2, hi - lo)));
  const after = (med - 0.5) * contrast + 0.5;
  const brightness = Math.max(-0.25, Math.min(0.25, (0.47 - after) * 0.9));
  // тёплый оттенок, если синего больше красного, и наоборот
  const temperature = mid ? Math.max(-0.5, Math.min(0.5, ((b - r) / mid / 255) * 3)) : 0;
  const s = sat / n;
  const saturation = s < 0.12 ? 1.25 : s < 0.22 ? 1.12 : s > 0.45 ? 0.95 : 1.04;
  const round = (v: number) => Math.round(v * 100) / 100;
  return { brightness: round(brightness), contrast: round(contrast), saturation: round(saturation), temperature: round(temperature) };
}

export async function autoColor(clipId: string, source?: string): Promise<ReturnType<typeof autoColorFor>> {
  const p = get().project!;
  const f = findClip(p, clipId);
  if (!f || f.clip.type !== 'media') throw new Error('Нет такого клипа');
  const c = f.clip;
  const m = mediaById(p, c.mediaId);
  if (!m || m.kind === 'audio' || m.missing) throw new Error('Автоцвет работает только для видео и фото');
  const local = Math.max(0, Math.min(clipDuration(c) - 0.05, get().playhead - c.start));
  const t = c.in + (local > 0 ? local : Math.min(1, clipDuration(c) / 2)) * c.speed;
  try {
    const fix = autoColorFor(await grabSource(m.path, m.kind, t));
    updateMediaClip(clipId, { color: { ...fix, gamma: 1 } }, 'Автоцвет', { source, coalesce: '' });
    if (!source || source === 'user') toast('success', 'Цвет выровнен', { detail: 'Ползунки во вкладке «Цвет» можно подправить. Ctrl+Z — вернуть как было.' });
    return fix;
  } catch (e) {
    toast('error', 'Не удалось подобрать цвет', { detail: clean(e) });
    throw e;
  }
}

// ── Размытие лиц ─────────────────────────────────────
export async function blurFaces(clipId: string, o: { strength?: number; source?: string } = {}): Promise<{ found: number; samples: number }> {
  const p = get().project!;
  const f = findClip(p, clipId);
  if (!f || f.clip.type !== 'media') throw new Error('Нет такого клипа');
  const c = f.clip;
  const m = mediaById(p, c.mediaId);
  if (!m || m.kind !== 'video' || m.missing) throw new Error('Лица ищутся только в видео');
  try { await faceDetector(); } catch {
    toast('error', 'Поиск лиц недоступен на этом компьютере', { detail: 'Видеокарта не дала программе WebGL.' });
    throw new Error('Поиск лиц недоступен');
  }
  const ctrl = new AbortController();
  const task = startTask('Ищу лица для размытия', () => ctrl.abort());
  const len = c.out - c.in;
  const step = Math.max(0.2, Math.min(0.5, len / 400));
  try {
    const samples = await faceBoxes(m.path, c.in, c.out, { step, signal: ctrl.signal, onProgress: k => updateTask(task, { progress: k }) });
    const found = samples.filter(s => s.boxes.length).length;
    const prev = (findClip(get().project!, clipId)?.clip as MediaClip | undefined)?.faces;
    updateMediaClip(clipId, { faces: { strength: o.strength ?? prev?.strength ?? 0.6, step, samples } }, found ? 'Лица размыты' : 'Лиц не нашлось', { source: o.source, coalesce: '' });
    if (!found) toast('info', 'Лиц в этом клипе не нашлось', { detail: 'Нейросеть лучше видит лица анфас и крупнее 3% кадра.' });
    else if (!o.source || o.source === 'user') toast('success', 'Лица размыты', { detail: 'Силу размытия можно поменять во вкладке «Эффекты».' });
    return { found, samples: samples.length };
  } catch (e) {
    const msg = clean(e);
    if (msg !== 'Отменено') toast('error', 'Не удалось найти лица', { detail: msg });
    throw new Error(msg);
  } finally {
    endTask(task);
  }
}

/** Маски лиц для экспорта: белые пятна на чёрном по времени исходника (от начала клипа в файле) */
export function faceMaskRenders(p: Project): { clipId: string; dataUrl: string; from: number; to: number }[] {
  const out: { clipId: string; dataUrl: string; from: number; to: number }[] = [];
  for (const t of p.tracks) {
    if (t.hidden || t.kind === 'audio' || t.kind === 'text') continue;
    for (const c of t.clips) {
      if (c.type !== 'media' || !c.faces?.samples.length) continue;
      const m = mediaById(p, c.mediaId);
      if (!m || m.kind !== 'video') continue;
      const W = 320, H = Math.max(2, Math.round((W * (m.height || 9)) / Math.max(1, m.width || 16)));
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d')!;
      const len = c.out - c.in, step = c.faces.step || 0.25;
      const inside = c.faces.samples.filter(s => s.t >= c.in - step && s.t <= c.out + step);
      let last = '';
      for (const [i, s] of inside.entries()) {
        const from = Math.max(0, i === 0 ? 0 : (s.t + inside[i - 1].t) / 2 - c.in);
        const to = Math.min(len, i === inside.length - 1 ? len : (s.t + inside[i + 1].t) / 2 - c.in);
        if (to - from < 1e-3) continue;
        const key = JSON.stringify(s.boxes);
        // соседние одинаковые маски склеиваем в одну подольше
        if (key === last && out.length && out[out.length - 1].clipId === 'faces:' + c.id) { out[out.length - 1].to = to; continue; }
        last = key;
        ctx.filter = 'none';
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
        ctx.filter = 'blur(3px)';
        ctx.fillStyle = '#fff';
        for (const b of s.boxes) {
          const [x, y, w, h] = padBox(b);
          ctx.beginPath();
          ctx.ellipse((x + w / 2) * W, (y + h / 2) * H, (w / 2) * W, (h / 2) * H, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        out.push({ clipId: 'faces:' + c.id, dataUrl: cv.toDataURL('image/png'), from, to });
      }
    }
  }
  return out;
}

// ── Подгонка музыки под длину ролика ─────────────────
export async function fitMusic(clipId: string, o: { source?: string } = {}): Promise<{ end: number; copies: number }> {
  const p = get().project!;
  const f = findClip(p, clipId);
  if (!f || f.clip.type !== 'media') throw new Error('Нет такого клипа');
  const c = f.clip;
  const m = mediaById(p, c.mediaId);
  if (!m?.hasAudio || m.missing) throw new Error('В этом клипе нет звука');
  // длина ролика — по картинке и тексту, без самой музыки
  let target = 0;
  for (const t of p.tracks) if (t.kind !== 'audio') for (const k of t.clips) target = Math.max(target, clipEnd(k));
  if (target <= c.start + 1) { toast('info', 'Сначала положите видео или фото на таймлайн', { detail: 'Музыка подгоняется под длину ролика.' }); throw new Error('Нет видео'); }
  const task = startTask('Подгоняю музыку под ролик');
  let beats: number[] = [];
  try {
    const r = await api.beats(m.path, c.in, m.duration);
    beats = (r.beats as number[]) || [];
  } catch { /* без ритма — просто красивое затухание */ } finally {
    endTask(task);
  }
  const fullLen = (m.duration - c.in) / c.speed; // сколько музыки есть от точки входа до конца файла
  const need = target - c.start;
  const copies = fullLen >= need ? 0 : Math.ceil((need - fullLen) / Math.max(1, (m.duration - c.in) / c.speed));
  // последний кусок: где поставить конец — на долю незадолго до конца видео
  const lastStart = c.start + copies * fullLen;
  const wantSrc = c.in + (target - lastStart) * c.speed;
  const near = beats.filter(b => b <= wantSrc + 0.02 && b >= wantSrc - 3 * c.speed);
  const endSrc = Math.min(m.duration, near.length ? near[near.length - 1] : wantSrc);
  const fade = Math.min(2.5, Math.max(0.8, (endSrc - c.in) / c.speed / 4));
  const ids: string[] = [];
  commit(copies ? `Музыка повторена ${copies + 1} раза и подогнана под ролик` : 'Музыка подогнана под длину ролика', pr => {
    const fr = findClip(pr, clipId)!;
    const cc = fr.clip as MediaClip;
    const track = fr.track;
    // убираем мешающие клипы этой дорожки после музыки
    const parts: MediaClip[] = [cc];
    for (let i = 0; i < copies; i++) {
      const k: MediaClip = { ...structuredClone(cc), id: uid('c'), start: c.start + (i + 1) * fullLen, in: c.in, out: m.duration, audioFadeIn: 0.3 };
      parts.push(k);
    }
    if (copies) { cc.out = m.duration; cc.audioFadeOut = 0.3; }
    const last = parts[parts.length - 1];
    last.out = Math.max(last.in + 0.5, endSrc);
    last.audioFadeOut = fade;
    const end = clipEnd(last);
    track.clips = track.clips.filter(k => parts.includes(k as MediaClip) || clipEnd(k) <= c.start + 1e-3 || k.start >= end - 1e-3);
    for (const k of parts.slice(1)) track.clips.push(k);
    track.clips.sort((a, b) => a.start - b.start);
    ids.push(...parts.map(k => k.id));
    return ids;
  }, { source: o.source });
  const end = clipEnd(findClip(get().project!, ids[ids.length - 1])!.clip);
  if (!o.source || o.source === 'user') toast('success', copies ? `Трек повторён и закончится вместе с видео` : 'Музыка закончится вместе с видео', { detail: near.length ? 'Конец попал точно на долю, в конце плавное затухание.' : 'В конце плавное затухание.' });
  return { end, copies };
}

// ── Шаблоны титров ───────────────────────────────────
type Part = { text: string; delay: number; dur?: number; style: Partial<TextStyle>; animIn: TextAnim; animOut: TextAnim };

export interface TitleTemplate {
  id: string;
  name: string;
  tip: string;
  duration: number;
  fields: string[]; // что человек вписывает: имя, должность…
  parts: (b: Brand, tall: boolean, texts: string[]) => Part[];
}

const pick = (texts: string[], i: number, def: string) => (texts[i] ?? '').trim() || def;

export const TITLE_TEMPLATES: TitleTemplate[] = [
  {
    id: 'lower-third', name: 'Имя и должность', tip: 'Плашка внизу кадра: кто говорит', duration: 5, fields: ['Иван Петров', 'основатель «Мастерской»'],
    parts: (b, tall, t) => {
      const x = tall ? 0.5 : 0.28, align = tall ? 'center' : 'left';
      return [
        { text: pick(t, 0, 'Иван Петров'), delay: 0, animIn: 'slide-right', animOut: 'slide-right', style: { font: b.font, size: tall ? 40 : 48, bold: true, color: b.text, align, x, y: tall ? 0.74 : 0.78, background: true, backgroundColor: b.primary, backgroundOpacity: 0.95, shadow: false, maxWidth: tall ? 0.85 : 0.45 } },
        { text: pick(t, 1, 'основатель «Мастерской»'), delay: 0.2, animIn: 'slide-right', animOut: 'slide-right', style: { font: b.font, size: tall ? 28 : 32, color: '#ffffff', align, x, y: tall ? 0.785 : 0.855, background: true, backgroundColor: '#111318', backgroundOpacity: 0.85, shadow: false, maxWidth: tall ? 0.85 : 0.45 } },
      ];
    },
  },
  {
    id: 'intro', name: 'Заставка', tip: 'Крупное название ролика в начале', duration: 4, fields: ['Как я построил баню', 'за 30 дней'],
    parts: (b, tall, t) => [
      { text: pick(t, 0, 'Как я построил баню'), delay: 0, animIn: 'zoom', animOut: 'fade', style: { font: 'Unbounded', size: tall ? 70 : 92, bold: true, color: b.text, y: 0.44, maxWidth: 0.86, strokeWidth: 0, shadow: true } },
      { text: pick(t, 1, 'за 30 дней'), delay: 0.45, animIn: 'slide-up', animOut: 'fade', style: { font: b.font, size: tall ? 44 : 52, bold: true, uppercase: true, color: '#111318', y: tall ? 0.53 : 0.58, background: true, backgroundColor: b.accent, backgroundOpacity: 1, shadow: false } },
    ],
  },
  {
    id: 'subscribe', name: 'Подпишись', tip: 'Яркий призыв подписаться', duration: 4, fields: ['Подпишись на канал', 'и нажми колокольчик 🔔'],
    parts: (b, tall, t) => [
      { text: '👆 ' + pick(t, 0, 'Подпишись на канал'), delay: 0, animIn: 'zoom', animOut: 'zoom', style: { font: 'Rubik', size: tall ? 52 : 60, bold: true, uppercase: true, color: '#ffffff', y: tall ? 0.62 : 0.74, background: true, backgroundColor: '#ff2d3d', backgroundOpacity: 1, shadow: true } },
      { text: pick(t, 1, 'и нажми колокольчик 🔔'), delay: 0.35, animIn: 'slide-up', animOut: 'fade', style: { font: b.font, size: tall ? 34 : 38, bold: true, color: '#ffffff', y: tall ? 0.69 : 0.83, strokeWidth: 5, strokeColor: '#000000' } },
    ],
  },
  {
    id: 'chapter', name: 'Раздел', tip: 'Номер и название части ролика', duration: 3, fields: ['01', 'Подготовка'],
    parts: (b, _tall, t) => [
      { text: pick(t, 0, '01'), delay: 0, animIn: 'fade', animOut: 'fade', style: { font: 'Unbounded', size: 150, bold: true, color: b.accent, y: 0.4, shadow: false } },
      { text: pick(t, 1, 'Подготовка'), delay: 0.25, animIn: 'slide-up', animOut: 'fade', style: { font: b.font, size: 64, bold: true, uppercase: true, color: b.text, y: 0.56, shadow: true } },
    ],
  },
  {
    id: 'sale', name: 'Скидка', tip: 'Крупная цена или скидка для рекламы', duration: 4, fields: ['−30%', 'только до воскресенья'],
    parts: (b, tall, t) => [
      { text: pick(t, 0, '−30%'), delay: 0, animIn: 'zoom', animOut: 'zoom', style: { font: 'Russo One', size: tall ? 170 : 200, color: '#ffe14d', strokeWidth: 10, strokeColor: '#000000', y: 0.42 } },
      { text: pick(t, 1, 'только до воскресенья'), delay: 0.3, animIn: 'slide-up', animOut: 'fade', style: { font: b.font, size: 46, bold: true, color: '#ffffff', y: tall ? 0.53 : 0.6, background: true, backgroundColor: b.primary, backgroundOpacity: 0.95, shadow: false } },
    ],
  },
  {
    id: 'question', name: 'Вопрос зрителям', tip: 'Просьба написать в комментариях', duration: 4, fields: ['А вы как думаете?', 'Пишите в комментариях 👇'],
    parts: (b, tall, t) => [
      { text: pick(t, 0, 'А вы как думаете?'), delay: 0, animIn: 'slide-up', animOut: 'fade', style: { font: b.font, size: tall ? 64 : 76, bold: true, color: b.text, y: tall ? 0.6 : 0.68, strokeWidth: 6, strokeColor: '#000000' } },
      { text: pick(t, 1, 'Пишите в комментариях 👇'), delay: 0.35, animIn: 'fade', animOut: 'fade', style: { font: b.font, size: 40, bold: true, color: '#111318', y: tall ? 0.67 : 0.79, background: true, backgroundColor: b.accent, backgroundOpacity: 1, shadow: false } },
    ],
  },
  {
    id: 'outro', name: 'Концовка', tip: 'Спасибо за просмотр и название канала', duration: 5, fields: ['Спасибо за просмотр!', 'Подписывайтесь — впереди много интересного'],
    parts: (b, tall, t) => [
      { text: pick(t, 0, 'Спасибо за просмотр!'), delay: 0, animIn: 'zoom', animOut: 'fade', style: { font: 'Unbounded', size: tall ? 66 : 84, bold: true, color: b.text, y: 0.42, maxWidth: 0.86 } },
      { text: pick(t, 1, 'Подписывайтесь — впереди много интересного'), delay: 0.4, animIn: 'slide-up', animOut: 'fade', style: { font: b.font, size: 40, color: '#ffffff', y: 0.53, maxWidth: 0.8 } },
      ...(b.name ? [{ text: b.name, delay: 0.8, animIn: 'fade' as TextAnim, animOut: 'fade' as TextAnim, style: { font: b.font, size: 44, bold: true, color: '#111318', y: 0.63, background: true, backgroundColor: b.accent, backgroundOpacity: 1, shadow: false } }] : []),
    ],
  },
];

export function addTitleTemplate(id: string, o: { start?: number; texts?: string[]; source?: string } = {}): string[] {
  const tpl = TITLE_TEMPLATES.find(t => t.id === id);
  if (!tpl) throw new Error('Нет такого шаблона: ' + id + '. Есть: ' + TITLE_TEMPLATES.map(t => t.id).join(', '));
  const s = get();
  const p0 = s.project!;
  const brand = { ...defaultBrand(), ...s.settings.brand };
  const at = Math.max(0, o.start ?? s.playhead);
  const parts = tpl.parts(brand, p0.height > p0.width, o.texts || []);
  const ids: string[] = [];
  commit(`Титр «${tpl.name}»`, p => {
    for (const part of parts) {
      const st = at + part.delay, dur = Math.max(0.5, (part.dur ?? tpl.duration) - part.delay);
      const c = makeTextClip(part.text, st, dur, part.style);
      c.animIn = part.animIn; c.animOut = part.animOut; c.animDuration = 0.45;
      const free = p.tracks.find(t => t.kind === 'text' && !t.locked && !t.name.startsWith('Субтитры') && t.clips.every(x => clipEnd(x) <= st + 1e-3 || x.start >= st + dur - 1e-3));
      const t = free || addTrack(p, 'text');
      t.clips.push(c);
      t.clips.sort((a, b) => a.start - b.start);
      ids.push(c.id);
    }
    return ids;
  }, { source: o.source });
  set({ selection: ids.slice(0, 1), inspectorTab: 'text' });
  return ids;
}

// ── Бренд-кит ────────────────────────────────────────
/** Логотип в углу на весь ролик */
export async function addBrandLogo(o: { source?: string } = {}): Promise<string | null> {
  const b = { ...defaultBrand(), ...get().settings.brand };
  if (!b.logo) { toast('info', 'Сначала выберите картинку логотипа', { detail: 'Настройки → Бренд-кит → «Выбрать логотип».' }); return null; }
  const [m] = await importFiles([b.logo]);
  if (!m) return null;
  const p = get().project!;
  const total = Math.max(3, projectDuration(p));
  const W = p.width, H = p.height;
  // размер логотипа задан долей высоты кадра; масштаб 1 — «вписать в кадр»
  const fitK = Math.min(W / (m.width || 1), H / (m.height || 1));
  const scale = (b.logoSize * H) / Math.max(1, (m.height || 1) * fitK);
  const lw = ((m.width || 1) * fitK * scale) / W, lh = (b.logoSize * H) / H;
  const pad = 0.03;
  const x = b.logoCorner.endsWith('l') ? pad * (H / W) + lw / 2 : 1 - pad * (H / W) - lw / 2;
  const y = b.logoCorner.startsWith('t') ? pad + lh / 2 : 1 - pad - lh / 2;
  // старый логотип того же файла убираем, чтобы не было двух
  const old = p.tracks.flatMap(t => t.clips).filter(c => c.type === 'media' && c.mediaId === m.id && c.label === 'Логотип').map(c => c.id);
  const c = makeMediaClip(m, { start: 0, out: total, label: 'Логотип', transform: { x, y, scale, rotation: 0, opacity: b.logoOpacity } });
  c.transformEnd = { ...c.transform };
  commit('Логотип на весь ролик', pr => {
    for (const t of pr.tracks) t.clips = t.clips.filter(k => !old.includes(k.id));
    let t = pr.tracks.find(x => x.kind === 'video' && x.name === 'Логотип');
    if (!t) { t = addTrack(pr, 'video'); t.name = 'Логотип'; }
    t.clips.push(c);
    return [c.id];
  }, { source: o.source });
  return c.id;
}

/** Шрифт и цвета бренда — всем надписям проекта (кроме субтитров, если не просили) */
export function applyBrandToTexts(o: { subtitles?: boolean; source?: string } = {}): number {
  const b = { ...defaultBrand(), ...get().settings.brand };
  let count = 0;
  commit('Бренд-кит применён к надписям', p => {
    const ids: string[] = [];
    for (const t of p.tracks) for (const c of t.clips) {
      if (c.type !== 'text' || (c.subtitle && !o.subtitles)) continue;
      c.style.font = b.font;
      if (c.style.background) c.style.backgroundColor = b.primary;
      if (!c.style.background || c.style.color.toLowerCase() === '#ffffff') c.style.color = b.text;
      if (c.highlight) c.highlight = b.accent;
      ids.push(c.id);
    }
    count = ids.length;
    return ids;
  }, { source: o.source });
  return count;
}
