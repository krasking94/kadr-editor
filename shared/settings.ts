// Настройки программы (хранятся в папке пользователя). Ключи нейросетей лежат отдельно в зашифрованном виде.

export interface ProviderSettings {
  baseUrl: string;
  model: string;
}

export interface McpClientConfig {
  id: string;
  name: string;
  type: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
}

export interface RecentProject {
  path: string;
  name: string;
  openedAt: number;
  thumb?: string;
}

export interface Settings {
  theme: 'dark' | 'light' | 'system';
  accent: string;
  autosaveMinutes: number;
  encoder: 'auto' | 'cpu' | 'nvenc' | 'qsv' | 'amf';
  exportDir: string;
  recent: RecentProject[];
  showTips: boolean;
  snapping: boolean;
  autoUpdate: boolean; // сама проверять новые версии
  loudness: number; // громкость при сохранении, LUFS; 0 — не выравнивать
  proxy: 'auto' | 'off'; // лёгкие копии тяжёлых видео для плавного просмотра
  layout: Layout;
  brand: Brand; // бренд-кит: свои цвета, шрифт и логотип (с 0.7)
  tourDone: boolean; // короткое обучение уже показано
  ai: {
    provider: string;
    providers: Record<string, ProviderSettings>;
    speechProvider: string;
    speechModel: string;
    speechLanguage: string;
  };
  gen: {
    imageProvider: string;
    imageModels: Record<string, string>; // своя модель для сервиса, если меняли
    imageBaseUrl: string; // для «своего адреса»
    imageAspect: string;
    voiceId: string;
    voiceName: string;
    ttsModel: string;
    videoModel: string; // ИИ-видео (fal.ai): модель для ролика по описанию
    videoImageModel: string; // и для «оживить фото»
    videoDuration: number; // секунды
  };
  mcp: {
    serverEnabled: boolean;
    port: number;
    clients: McpClientConfig[];
  };
  // с 0.9
  publish: PublishSettings;
  reports: { url: string; auto: boolean }; // куда отправлять отчёты об ошибках (пусто — только сохранять на компьютере)
  prompter: { text: string; speed: number; size: number; mirror: boolean };
  // с 1.0
  separation: 'fast' | 'best'; // как отделять голос от музыки: быстро или качественно
}

export interface PublishSettings {
  telegramChat: string; // @канал или числовой id чата
  youtubeClientId: string; // клиент OAuth Google «для компьютера»
  youtubePrivacy: 'private' | 'unlisted' | 'public';
  vkAppId: string; // ID Standalone-приложения ВК
  vkGroupId: string; // сообщество, куда загружать (пусто — на свою страницу)
}

export const defaultPublish = (): PublishSettings => ({ telegramChat: '', youtubeClientId: '', youtubePrivacy: 'private', vkAppId: '', vkGroupId: '' });
export const defaultPrompter = () => ({ text: '', speed: 1, size: 56, mirror: false });

export interface Brand {
  name: string; // название канала или компании, например @мой_канал
  font: string;
  primary: string; // главный цвет: плашки титров
  accent: string; // второй цвет: выделения
  text: string; // цвет надписей
  logo: string; // путь к картинке логотипа
  logoCorner: 'tl' | 'tr' | 'bl' | 'br';
  logoSize: number; // доля высоты кадра
  logoOpacity: number;
}

export const defaultBrand = (): Brand => ({
  name: '', font: 'Montserrat', primary: '#7c5cff', accent: '#ffd60a', text: '#ffffff', logo: '', logoCorner: 'tr', logoSize: 0.12, logoOpacity: 0.9,
});

// Расположение панелей: ширины тянутся мышкой, стороны можно поменять местами
export interface Layout {
  side: number; // ширина левой панели, px
  right: number; // ширина панели настроек клипа, px
  assistant: number; // ширина ИИ-помощника, px
  timeline: number; // высота таймлайна, px
  swap: boolean; // медиатека справа, настройки слева
  // Свободные окна (с 0.4): какие панели пристыкованы слева и справа (по порядку слева направо)
  // и какие плавают поверх. Если пусто — раскладка берётся из swap, как в 0.3.
  dockLeft?: PaneId[];
  dockRight?: PaneId[];
  float?: Partial<Record<PaneId, FloatRect>>;
  rail?: 'left' | 'right'; // где кнопки медиатеки, когда сама панель плавает
}

export type PaneId = 'files' | 'inspector' | 'assistant';
export interface FloatRect { x: number; y: number; w: number; h: number }

export const defaultLayout = (): Layout => ({ side: 320, right: 340, assistant: 360, timeline: 300, swap: false });

export const defaultSettings = (): Settings => ({
  theme: 'dark',
  accent: '#7c5cff',
  autosaveMinutes: 2,
  encoder: 'auto',
  exportDir: '',
  recent: [],
  showTips: true,
  snapping: true,
  autoUpdate: true,
  loudness: -14,
  proxy: 'auto',
  layout: defaultLayout(),
  brand: defaultBrand(),
  tourDone: false,
  // речь по умолчанию распознаётся на компьютере: без ключей и интернета (с 1.0)
  ai: { provider: 'anthropic', providers: {}, speechProvider: 'local', speechModel: '', speechLanguage: 'ru' },
  gen: { imageProvider: 'openai', imageModels: {}, imageBaseUrl: '', imageAspect: 'auto', voiceId: '', voiceName: '', ttsModel: 'eleven_v4', videoModel: 'fal-ai/kling-video/v2.5-turbo/pro/text-to-video', videoImageModel: 'fal-ai/kling-video/v2.5-turbo/pro/image-to-video', videoDuration: 5 },
  mcp: { serverEnabled: true, port: 7788, clients: [] },
  publish: defaultPublish(),
  reports: { url: '', auto: false },
  prompter: defaultPrompter(),
  separation: 'best',
});
