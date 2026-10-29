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
  ai: {
    provider: string;
    providers: Record<string, ProviderSettings>;
    speechProvider: string;
    speechModel: string;
    speechLanguage: string;
  };
  mcp: {
    serverEnabled: boolean;
    port: number;
    clients: McpClientConfig[];
  };
}

export const defaultSettings = (): Settings => ({
  theme: 'dark',
  accent: '#7c5cff',
  autosaveMinutes: 2,
  encoder: 'auto',
  exportDir: '',
  recent: [],
  showTips: true,
  snapping: true,
  ai: { provider: 'anthropic', providers: {}, speechProvider: 'openai', speechModel: 'whisper-1', speechLanguage: 'ru' },
  mcp: { serverEnabled: true, port: 7788, clients: [] },
});
