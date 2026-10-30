// Расчёты таймлайна, общие для окна программы, экспорта и ИИ-инструментов.
import { keysOf, transformAtKeys } from './keyframes';
import type {
  Clip, ColorSettings, Effects, MediaClip, MediaItem, Project, TextClip, TextStyle, Track, Transform,
} from './types';

export const MIN_CLIP = 0.1;

export function uid(prefix = ''): string {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export const defaultTransform = (): Transform => ({ x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1 });

export const defaultColor = (): ColorSettings => ({
  preset: 'none', brightness: 0, contrast: 1, saturation: 1, gamma: 1, temperature: 0,
});

export const defaultEffects = (): Effects => ({
  blur: 0, vignette: 0, sharpen: 0, grain: 0, flipH: false, flipV: false,
});

export const defaultTextStyle = (): TextStyle => ({
  font: 'Onest', size: 70, color: '#ffffff', bold: true, italic: false, align: 'center',
  strokeWidth: 0, strokeColor: '#000000', shadow: true, background: false,
  backgroundColor: '#000000', backgroundOpacity: 0.6, uppercase: false,
  x: 0.5, y: 0.5, maxWidth: 0.85, lineHeight: 1.15,
});

export function clipDuration(c: Clip): number {
  if (c.type === 'text') return c.duration;
  return Math.max(MIN_CLIP, (c.out - c.in) / (c.speed || 1));
}

export function clipEnd(c: Clip): number {
  return c.start + clipDuration(c);
}

export function mainTrack(p: Project): Track {
  return p.tracks.find(t => t.kind === 'main')!;
}

// Магнитная главная дорожка: клипы идут встык, переход «наезжает» на предыдущий клип.
export function transitionDuration(prev: Clip | undefined, c: MediaClip): number {
  if (!prev || !c.transition) return 0;
  const limit = Math.min(clipDuration(prev), clipDuration(c)) / 2;
  return Math.max(0, Math.min(c.transition.duration, limit));
}

export function layoutMain(track: Track): void {
  let t = 0;
  let prev: Clip | undefined;
  for (const c of track.clips) {
    if (c.type !== 'media') continue;
    const td = transitionDuration(prev, c);
    c.start = Math.max(0, t - td);
    t = c.start + clipDuration(c);
    prev = c;
  }
}

export function layoutProject(p: Project): void {
  layoutMain(mainTrack(p));
}

export function projectDuration(p: Project): number {
  let end = 0;
  for (const t of p.tracks) for (const c of t.clips) end = Math.max(end, clipEnd(c));
  return end;
}

export function findClip(p: Project, id: string): { clip: Clip; track: Track; index: number } | null {
  for (const track of p.tracks) {
    const index = track.clips.findIndex(c => c.id === id);
    if (index >= 0) return { clip: track.clips[index], track, index };
  }
  return null;
}

export function mediaById(p: Project, id: string): MediaItem | undefined {
  return p.media.find(m => m.id === id);
}

export function newProject(name = 'Новый проект', width = 1920, height = 1080, fps = 30): Project {
  const now = Date.now();
  return {
    version: 1, id: uid('p'), name, width, height, fps, background: '#000000', media: [],
    tracks: [
      { id: uid('t'), kind: 'main', name: 'Основное видео', muted: false, locked: false, hidden: false, clips: [] },
      { id: uid('t'), kind: 'video', name: 'Наложение', muted: false, locked: false, hidden: false, clips: [] },
      { id: uid('t'), kind: 'text', name: 'Текст', muted: false, locked: false, hidden: false, clips: [] },
      { id: uid('t'), kind: 'audio', name: 'Музыка', muted: false, locked: false, hidden: false, clips: [] },
    ],
    markers: [], createdAt: now, updatedAt: now,
  };
}

export function makeMediaClip(m: MediaItem, opts: Partial<MediaClip> = {}): MediaClip {
  const dur = m.kind === 'image' ? 5 : m.duration;
  return {
    type: 'media', id: uid('c'), mediaId: m.id, start: 0, in: 0, out: dur, speed: 1,
    volume: 1, muted: false, audioFadeIn: 0, audioFadeOut: 0, fadeIn: 0, fadeOut: 0, fit: 'fit',
    transform: defaultTransform(), animate: false, transformEnd: defaultTransform(),
    color: defaultColor(), effects: defaultEffects(), ...opts,
  };
}

export function makeTextClip(text: string, start: number, duration = 3, style: Partial<TextStyle> = {}): TextClip {
  return {
    type: 'text', id: uid('x'), start, duration, text, style: { ...defaultTextStyle(), ...style },
    animIn: 'fade', animOut: 'fade', animDuration: 0.4,
  };
}

// Значение кусочно-линейного пути в момент t
export function pathAt(points: { t: number; x: number; y: number }[], t: number): { x: number; y: number } {
  if (t <= points[0].t) return points[0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (t < b.t) {
      const k = (t - a.t) / Math.max(1e-3, b.t - a.t);
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    }
  }
  return points[points.length - 1];
}

// Положение анимированного слоя в момент local (0..длительность клипа)
export function transformAt(c: MediaClip, local: number): Transform {
  let tr = c.keys?.length || c.animate ? transformAtKeys(keysOf(c), local) : c.transform;
  if (c.path?.length) tr = { ...tr, ...pathAt(c.path, local) };
  return tr;
}

// Цветовые пресеты: одинаковые значения для просмотра и экспорта
export const COLOR_PRESETS: Record<string, { label: string; css: string; ff: string }> = {
  none: { label: 'Без фильтра', css: '', ff: '' },
  bw: { label: 'Чёрно-белый', css: 'grayscale(1)', ff: 'hue=s=0' },
  sepia: { label: 'Сепия', css: 'sepia(0.85)', ff: 'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131' },
  vintage: { label: 'Винтаж', css: 'sepia(0.35) contrast(0.9) saturate(0.8)', ff: 'curves=preset=vintage' },
  warm: { label: 'Тёплый', css: 'sepia(0.2) saturate(1.15)', ff: 'colortemperature=temperature=4800' },
  cold: { label: 'Холодный', css: 'hue-rotate(-12deg) saturate(0.9) brightness(1.03)', ff: 'colortemperature=temperature=8500' },
  cinema: { label: 'Кино', css: 'contrast(1.12) saturate(0.85)', ff: 'eq=contrast=1.12:saturation=0.85,colorbalance=rs=-0.05:bs=0.06:rh=0.06:bh=-0.05' },
  vivid: { label: 'Сочный', css: 'saturate(1.45) contrast(1.06)', ff: 'eq=saturation=1.45:contrast=1.06' },
  fade: { label: 'Выцветший', css: 'contrast(0.82) brightness(1.08) saturate(0.75)', ff: 'eq=contrast=0.82:brightness=0.04:saturation=0.75' },
  cross: { label: 'Кросс-процесс', css: 'hue-rotate(15deg) saturate(1.3) contrast(1.1)', ff: 'curves=preset=cross_process' },
};

// CSS-фильтр для просмотра в окне программы
export function cssFilter(c: MediaClip, previewScale = 1): string {
  const col = c.color, fx = c.effects;
  const parts: string[] = [];
  const preset = COLOR_PRESETS[col.preset]?.css;
  if (preset) parts.push(preset);
  if (col.brightness) parts.push(`brightness(${(1 + col.brightness).toFixed(3)})`);
  if (col.contrast !== 1) parts.push(`contrast(${col.contrast.toFixed(3)})`);
  if (col.saturation !== 1) parts.push(`saturate(${col.saturation.toFixed(3)})`);
  if (col.temperature > 0) parts.push(`sepia(${(col.temperature * 0.35).toFixed(3)})`);
  if (col.temperature < 0) parts.push(`hue-rotate(${(col.temperature * 15).toFixed(1)}deg)`);
  if (fx.blur) parts.push(`blur(${(fx.blur * 20 * previewScale).toFixed(2)}px)`);
  return parts.join(' ');
}

export function formatTime(sec: number, fps = 30, withFrames = false): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  let out = (h ? h + ':' + pad(m) : String(m)) + ':' + pad(s);
  if (withFrames) out += '.' + pad(Math.floor((sec % 1) * fps));
  return out;
}

export const FORMAT_PRESETS = [
  { id: 'youtube', label: 'YouTube', hint: '16:9 · 1920×1080', width: 1920, height: 1080 },
  { id: 'reels', label: 'Reels, TikTok, Shorts', hint: '9:16 · 1080×1920', width: 1080, height: 1920 },
  { id: 'square', label: 'Квадрат', hint: '1:1 · 1080×1080', width: 1080, height: 1080 },
  { id: 'post', label: 'Пост ВК, Instagram', hint: '4:5 · 1080×1350', width: 1080, height: 1350 },
  { id: '4k', label: '4K', hint: '16:9 · 3840×2160', width: 3840, height: 2160 },
  { id: 'cinema', label: 'Кино', hint: '21:9 · 2560×1080', width: 2560, height: 1080 },
];

export const TRANSITIONS: { id: string; label: string }[] = [
  { id: 'fade', label: 'Наплыв' }, { id: 'fadeblack', label: 'Через чёрный' }, { id: 'fadewhite', label: 'Через белый' },
  { id: 'dissolve', label: 'Растворение' }, { id: 'wipeleft', label: 'Шторка влево' }, { id: 'wiperight', label: 'Шторка вправо' },
  { id: 'wipeup', label: 'Шторка вверх' }, { id: 'wipedown', label: 'Шторка вниз' }, { id: 'slideleft', label: 'Сдвиг влево' },
  { id: 'slideright', label: 'Сдвиг вправо' }, { id: 'slideup', label: 'Сдвиг вверх' }, { id: 'slidedown', label: 'Сдвиг вниз' },
  { id: 'circleopen', label: 'Круг открывается' }, { id: 'circleclose', label: 'Круг закрывается' }, { id: 'radial', label: 'Радар' },
  { id: 'zoomin', label: 'Приближение' }, { id: 'pixelize', label: 'Пиксели' }, { id: 'smoothleft', label: 'Плавно влево' },
  { id: 'smoothright', label: 'Плавно вправо' },
];

export const TEXT_ANIMS: { id: string; label: string }[] = [
  { id: 'none', label: 'Без анимации' }, { id: 'fade', label: 'Проявление' }, { id: 'slide-up', label: 'Снизу вверх' },
  { id: 'slide-down', label: 'Сверху вниз' }, { id: 'slide-left', label: 'Справа' }, { id: 'slide-right', label: 'Слева' },
  { id: 'zoom', label: 'Увеличение' },
];

// Состояние анимации текста в момент local: прозрачность и сдвиг (доли кадра), масштаб
export function textAnimState(c: TextClip, local: number): { opacity: number; dx: number; dy: number; scale: number } {
  const d = Math.max(0.01, Math.min(c.animDuration, c.duration / 2));
  let opacity = 1, dx = 0, dy = 0, scale = 1;
  const apply = (anim: string, k: number) => {
    // k: 0 — начало анимации (скрыт), 1 — на месте
    const e = 1 - Math.pow(1 - k, 3);
    if (anim === 'none') return;
    opacity *= e;
    const off = (1 - e) * 0.08;
    if (anim === 'slide-up') dy += off;
    if (anim === 'slide-down') dy -= off;
    if (anim === 'slide-left') dx += off;
    if (anim === 'slide-right') dx -= off;
    if (anim === 'zoom') scale *= 0.7 + 0.3 * e;
  };
  if (local < d) apply(c.animIn, Math.max(0, local / d));
  const rem = c.duration - local;
  if (rem < d) apply(c.animOut, Math.max(0, rem / d));
  return { opacity, dx, dy, scale };
}
