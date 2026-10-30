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
  };
  mcp: {
    serverEnabled: boolean;
    port: number;
    clients: McpClientConfig[];
  };
}

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
  ai: { provider: 'anthropic', providers: {}, speechProvider: 'openai', speechModel: 'whisper-1', speechLanguage: 'ru' },
  gen: { imageProvider: 'openai', imageModels: {}, imageBaseUrl: '', imageAspect: 'auto', voiceId: '', voiceName: '', ttsModel: 'eleven_v4' },
  mcp: { serverEnabled: true, port: 7788, clients: [] },
});
