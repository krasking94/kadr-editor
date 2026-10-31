// Общие типы проекта «Хлопушка». Их используют и окно программы, и экспорт, и ИИ-инструменты.

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
  transcript?: Transcript; // распознанная речь всего файла (время слов — от начала файла)
  proxy?: string;
  alpha?: boolean; // у видео прозрачный фон (WebM VP9 с альфа-каналом) // лёгкая копия для плавного просмотра; сохранение всегда идёт из оригинала
}

export interface Transcript {
  words: Word[];
  language?: string;
  at: number; // когда распознано
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
  lut?: string; // путь к файлу .cube — готовый «цветовой рецепт»
  wheels?: ColorWheels; // цветовые круги: оттенок отдельно для теней, середины и светов
}

// Цветовой круг: в какую сторону (оттенок, градусы) и насколько (0..1) сдвинуть цвет
export interface Wheel {
  hue: number;
  amount: number;
}

export interface ColorWheels {
  shadows: Wheel;
  midtones: Wheel;
  highlights: Wheel;
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
  denoise?: number; // 0..1 — убрать шум из звука
  voice?: boolean; // «голос как в студии»: тембр, выравнивание громкости
  key?: ChromaKey; // убрать фон заданного цвета (хромакей)
  path?: PathPoint[]; // движение центра слоя по точкам (слежение за лицом), время от начала клипа
  keys?: Keyframe[]; // ключевые кадры (если есть, заменяют transform/animate)
  origin?: ClipOrigin; // клип сделан из обработанной копии файла (стабилизация, задом наперёд)
  // с 0.7
  blend?: BlendMode; // как слой смешивается с тем, что под ним (только дорожки наложения)
  adjust?: boolean; // корректирующий слой: своего изображения нет, цвет и эффекты применяются ко всему, что ниже
  crop?: Crop; // обрезка краёв кадра, доли исходника
  mask?: MaskShape; // форма слоя
  smooth?: boolean; // плавное замедление: программа дорисовывает недостающие кадры
  faces?: FaceBlur; // размытие лиц
  eq?: AudioEq; // эквалайзер и компрессор
}

export type BlendMode = 'normal' | 'screen' | 'multiply' | 'overlay' | 'softlight' | 'lighten' | 'darken' | 'difference' | 'add';

export type MaskShape = 'none' | 'rounded' | 'ellipse' | 'circle';

export interface Crop {
  l: number; // сколько срезать слева, доля ширины (0..0.9)
  r: number;
  t: number; // сверху, доля высоты
  b: number;
}

export interface FaceBlur {
  strength: number; // 0..1
  // найденные лица по времени исходника: рамки [x, y, w, h] в долях кадра исходника
  samples: { t: number; boxes: [number, number, number, number][] }[];
  step: number; // через сколько секунд исходника идут образцы
}

export interface AudioEq {
  low: number; // басы, дБ (−12..12)
  mid: number; // середина, дБ
  high: number; // верха, дБ
  comp: number; // компрессор 0..1: выравнивает громкость (0 — выключен)
}

// Ключевой кадр: состояние слоя в момент t (секунды от начала клипа на таймлайне)
export interface Keyframe extends Transform {
  t: number;
  ease?: 'smooth' | 'linear'; // как двигаться к следующему ключу: плавно (по умолчанию) или ровно
}

export interface ChromaKey {
  color: string; // #rrggbb
  similarity: number; // 0.01..0.6 — насколько близкие оттенки тоже убирать
  blend: number; // 0..0.5 — мягкость края
}

export interface PathPoint {
  t: number;
  x: number;
  y: number;
}

export interface ClipOrigin {
  mediaId: string;
  in: number;
  out: number;
  done: ('stabilize' | 'reverse' | 'nobg')[];
}

export interface Word {
  s: number; // начало слова от начала клипа, сек
  e: number; // конец
  w: string;
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
  words?: Word[]; // слова со временем — для субтитров «слово за словом»
  highlight?: string; // цвет произносимого слова (если есть words)
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
  volume?: number; // громкость всей дорожки 0..2 (микшер), по умолчанию 1
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
  loudness?: number; // целевая громкость в LUFS (−14 для YouTube и ВК); не задано — без выравнивания
}

// Картинки текста, которые окно программы рисует для экспорта
export interface TextRender {
  clipId: string;
  path: string; // PNG размером с кадр
  from?: number; // для субтитров «слово за словом»: картинка показывается с from до to (от начала клипа)
  to?: number;
}
