// Общие типы проекта «Кадр». Их используют и окно программы, и экспорт, и ИИ-инструменты.

export type MediaKind = 'video' | 'image' | 'audio';

export interface MediaItem {
  id: string;
  path: string;
  name: string;
  kind: MediaKind;
  duration: number; // секунды; для картинок — длительность по умолчанию
  width: number;
  height: number;
  hasAudio: boolean;
  fps: number;
  size: number; // байты
  thumb?: string; // путь к миниатюре
  filmstrip?: string[]; // кадры для дорожки
  waveform?: number[]; // пики 0..1
  missing?: boolean;
}

export interface Transform {
  x: number; // центр слоя, доля ширины кадра (0.5 = середина)
  y: number; // центр слоя, доля высоты кадра
  scale: number; // 1 = вписать в кадр
  rotation: number; // градусы
  opacity: number; // 0..1
}

export interface ColorSettings {
  preset: ColorPreset;
  brightness: number; // -1..1, 0 = как есть
  contrast: number; // 0..2, 1 = как есть
  saturation: number; // 0..3, 1 = как есть
  gamma: number; // 0.1..3, 1 = как есть
  temperature: number; // -1 (холоднее) .. 1 (теплее)
}

export type ColorPreset =
  | 'none' | 'bw' | 'sepia' | 'vintage' | 'warm' | 'cold' | 'cinema' | 'vivid' | 'fade' | 'cross';

export interface Effects {
  blur: number; // 0..1
  vignette: number; // 0..1
  sharpen: number; // 0..1
  grain: number; // 0..1
  flipH: boolean;
  flipV: boolean;
}

export type TransitionType =
  | 'fade' | 'fadeblack' | 'fadewhite' | 'dissolve' | 'wipeleft' | 'wiperight' | 'wipeup' | 'wipedown'
  | 'slideleft' | 'slideright' | 'slideup' | 'slidedown' | 'circleopen' | 'circleclose'
  | 'radial' | 'zoomin' | 'pixelize' | 'smoothleft' | 'smoothright';

export interface Transition {
  type: TransitionType;
  duration: number;
}

export interface MediaClip {
  type: 'media';
  id: string;
  mediaId: string;
  start: number; // начало на таймлайне (для главной дорожки вычисляется)
  in: number; // начало в исходнике, сек
  out: number; // конец в исходнике, сек
  speed: number;
  volume: number; // 0..2
  muted: boolean;
  audioFadeIn: number;
  audioFadeOut: number;
  fadeIn: number; // плавное появление картинки
  fadeOut: number;
  fit: 'fit' | 'fill';
  transform: Transform;
  animate: boolean; // анимация от transform к transformEnd за время клипа
  transformEnd: Transform;
  color: ColorSettings;
  effects: Effects;
  transition?: Transition; // переход ИЗ предыдущего клипа (только главная дорожка)
  duck?: boolean; // приглушать эту музыку под голос
  label?: string;
}

export type TextAnim = 'none' | 'fade' | 'slide-up' | 'slide-down' | 'slide-left' | 'slide-right' | 'zoom';

export interface TextStyle {
  font: string;
  size: number; // доля высоты кадра * 1000 (60 = 6% высоты)
  color: string;
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right';
  strokeWidth: number;
  strokeColor: string;
  shadow: boolean;
  background: boolean;
  backgroundColor: string;
  backgroundOpacity: number;
  uppercase: boolean;
  x: number; // центр текста, доля ширины
  y: number; // центр текста, доля высоты
  maxWidth: number; // доля ширины
  lineHeight: number;
}

export interface TextClip {
  type: 'text';
  id: string;
  start: number;
  duration: number;
  text: string;
  style: TextStyle;
  animIn: TextAnim;
  animOut: TextAnim;
  animDuration: number;
  subtitle?: boolean;
}

export type Clip = MediaClip | TextClip;

export type TrackKind = 'main' | 'video' | 'text' | 'audio';

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  muted: boolean;
  locked: boolean;
  hidden: boolean;
  clips: Clip[];
}

export interface Marker {
  id: string;
  time: number;
  label: string;
  color: string;
}

export interface Project {
  version: 1;
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  background: string;
  media: MediaItem[];
  tracks: Track[]; // снизу вверх по слоям: [0] — главная дорожка
  markers: Marker[];
  createdAt: number;
  updatedAt: number;
}

export interface ExportOptions {
  outPath: string;
  format: 'mp4' | 'webm' | 'mov' | 'gif' | 'mp3' | 'wav' | 'png';
  width: number;
  height: number;
  fps: number;
  quality: 'draft' | 'good' | 'best';
  encoder: 'auto' | 'cpu' | 'nvenc' | 'qsv' | 'amf';
  rangeStart?: number;
  rangeEnd?: number;
}

// Картинки текста, которые окно программы рисует для экспорта
export interface TextRender {
  clipId: string;
  path: string; // PNG размером с кадр
}
