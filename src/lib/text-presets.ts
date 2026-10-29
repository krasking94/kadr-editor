// Готовые стили текста: выбираешь — и надпись уже красиво оформлена.
import type { TextAnim, TextStyle } from '../../shared/types';

export interface TextPreset {
  id: string;
  name: string;
  text: string;
  duration: number;
  style: Partial<TextStyle>;
  animIn: TextAnim;
  animOut: TextAnim;
}

export const TEXT_PRESETS: TextPreset[] = [
  { id: 'title', name: 'Заголовок', text: 'Заголовок', duration: 3, animIn: 'zoom', animOut: 'fade', style: { font: 'Unbounded', size: 96, bold: true, y: 0.45 } },
  { id: 'subtitle', name: 'Подзаголовок', text: 'Подзаголовок', duration: 3, animIn: 'slide-up', animOut: 'fade', style: { font: 'Onest', size: 50, color: '#e6e6f0', y: 0.58 } },
  { id: 'lower', name: 'Плашка с именем', text: 'Иван Петров\nвидеоблогер', duration: 4, animIn: 'slide-right', animOut: 'slide-right', style: { font: 'Montserrat', size: 44, bold: true, align: 'left', x: 0.24, y: 0.8, background: true, backgroundColor: '#7c5cff', backgroundOpacity: 0.92, shadow: false, maxWidth: 0.4 } },
  { id: 'caption', name: 'Субтитр', text: 'Так выглядит субтитр', duration: 2.5, animIn: 'none', animOut: 'none', style: { size: 52, bold: true, y: 0.86, background: true, backgroundOpacity: 0.55, shadow: false, maxWidth: 0.8 } },
  { id: 'tiktok', name: 'Яркий TikTok', text: 'ВОТ ЭТО ДА!', duration: 2, animIn: 'zoom', animOut: 'zoom', style: { font: 'Rubik', size: 110, bold: true, uppercase: true, color: '#ffe14d', strokeWidth: 10, strokeColor: '#000000', y: 0.4 } },
  { id: 'neon', name: 'Неон', text: 'Неон', duration: 3, animIn: 'fade', animOut: 'fade', style: { font: 'Comfortaa', size: 100, bold: true, color: '#ff5cf0', strokeWidth: 3, strokeColor: '#ffffff', shadow: true } },
  { id: 'quote', name: 'Цитата', text: '«Лучшее время начать —\nсейчас»', duration: 4, animIn: 'fade', animOut: 'fade', style: { font: 'PT Serif', size: 64, italic: true, lineHeight: 1.3 } },
  { id: 'handwritten', name: 'Рукописный', text: 'С любовью', duration: 3, animIn: 'slide-up', animOut: 'fade', style: { font: 'Caveat', size: 120, color: '#fff3e0' } },
  { id: 'cinema', name: 'Кино-титр', text: 'ГЛАВА ПЕРВАЯ', duration: 4, animIn: 'fade', animOut: 'fade', style: { font: 'Oswald', size: 60, uppercase: true, color: '#f4f1ea', shadow: false } },
  { id: 'sport', name: 'Спорт', text: 'ГОЛ!', duration: 2, animIn: 'zoom', animOut: 'fade', style: { font: 'Russo One', size: 140, italic: true, color: '#ffffff', strokeWidth: 8, strokeColor: '#ff3b3b' } },
  { id: 'retro', name: 'Ретро-игра', text: 'GAME OVER', duration: 3, animIn: 'fade', animOut: 'fade', style: { font: 'Press Start 2P', size: 60, color: '#7CFF6B', shadow: true } },
  { id: 'logo', name: 'Лого в углу', text: '@мой_канал', duration: 10, animIn: 'fade', animOut: 'fade', style: { font: 'Onest', size: 34, bold: true, x: 0.88, y: 0.07, color: '#ffffff', shadow: true, align: 'right' } },
];

export const presetById = (id: string) => TEXT_PRESETS.find(p => p.id === id);
