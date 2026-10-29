// Шрифты для титров. Все поддерживают кириллицу и бесплатны (лицензия OFL).
export const FONTS: { family: string; file: string; weight?: string; label: string; style: string }[] = [
  { family: 'Onest', file: 'Onest-VF.ttf', weight: '100 900', label: 'Onest', style: 'Современный' },
  { family: 'Montserrat', file: 'Montserrat-VF.ttf', weight: '100 900', label: 'Montserrat', style: 'Заголовки' },
  { family: 'Rubik', file: 'Rubik-VF.ttf', weight: '300 900', label: 'Rubik', style: 'Мягкий' },
  { family: 'Unbounded', file: 'Unbounded-VF.ttf', weight: '200 900', label: 'Unbounded', style: 'Широкий' },
  { family: 'Oswald', file: 'Oswald-VF.ttf', weight: '200 700', label: 'Oswald', style: 'Узкий' },
  { family: 'Russo One', file: 'RussoOne-Regular.ttf', label: 'Russo One', style: 'Спорт' },
  { family: 'Comfortaa', file: 'Comfortaa-VF.ttf', weight: '300 700', label: 'Comfortaa', style: 'Округлый' },
  { family: 'PT Serif', file: 'PT_Serif-Web-Regular.ttf', label: 'PT Serif', style: 'С засечками' },
  { family: 'Caveat', file: 'Caveat-VF.ttf', weight: '400 700', label: 'Caveat', style: 'Рукописный' },
  { family: 'Lobster', file: 'Lobster-Regular.ttf', label: 'Lobster', style: 'Каллиграфия' },
  { family: 'Press Start 2P', file: 'PressStart2P-Regular.ttf', label: 'Press Start 2P', style: 'Пиксельный' },
  { family: 'JetBrains Mono', file: 'JetBrainsMono-VF.ttf', weight: '100 800', label: 'JetBrains Mono', style: 'Моноширинный' },
];

let loaded: Promise<void> | null = null;

export function loadFonts(): Promise<void> {
  if (loaded) return loaded;
  const faces = FONTS.map(f => new FontFace(f.family, `url(./fonts/${f.file})`, f.weight ? { weight: f.weight } : {}));
  faces.push(new FontFace('PT Serif', 'url(./fonts/PT_Serif-Web-Bold.ttf)', { weight: '700' }));
  loaded = Promise.all(faces.map(f => f.load().then(ff => { document.fonts.add(ff); }).catch(() => undefined))).then(() => undefined);
  return loaded;
}
