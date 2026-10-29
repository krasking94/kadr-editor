// Готовые настройки нейросетей. Любую другую можно подключить как «Свой адрес» (OpenAI-совместимый API).

export type ProviderKind = 'anthropic' | 'openai';

export interface ProviderPreset {
  id: string;
  kind: ProviderKind;
  label: string;
  baseUrl: string;
  model: string;
  needsKey: boolean;
  vision: boolean;
  keyUrl?: string;
  hint?: string;
  speechModel?: string; // модель распознавания речи, если сервис её умеет
}

export const PROVIDERS: ProviderPreset[] = [
  { id: 'anthropic', kind: 'anthropic', label: 'Claude (Anthropic)', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5', needsKey: true, vision: true, keyUrl: 'https://console.anthropic.com/settings/keys', hint: 'Лучше всех понимает монтаж и видит кадры.' },
  { id: 'openai', kind: 'openai', label: 'ChatGPT (OpenAI)', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini', needsKey: true, vision: true, keyUrl: 'https://platform.openai.com/api-keys', speechModel: 'whisper-1' },
  { id: 'gemini', kind: 'openai', label: 'Gemini (Google)', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', needsKey: true, vision: true, keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'deepseek', kind: 'openai', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', needsKey: true, vision: false, keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'openrouter', kind: 'openai', label: 'OpenRouter (сотни моделей)', baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/auto', needsKey: true, vision: true, keyUrl: 'https://openrouter.ai/keys', hint: 'Один ключ для моделей разных компаний.' },
  { id: 'groq', kind: 'openai', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', needsKey: true, vision: false, keyUrl: 'https://console.groq.com/keys', speechModel: 'whisper-large-v3' },
  { id: 'mistral', kind: 'openai', label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-large-latest', needsKey: true, vision: false, keyUrl: 'https://console.mistral.ai/api-keys' },
  { id: 'xai', kind: 'openai', label: 'Grok (xAI)', baseUrl: 'https://api.x.ai/v1', model: 'grok-4', needsKey: true, vision: true, keyUrl: 'https://console.x.ai' },
  { id: 'qwen', kind: 'openai', label: 'Qwen (Alibaba)', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', needsKey: true, vision: false },
  { id: 'yandex', kind: 'openai', label: 'YandexGPT', baseUrl: 'https://llm.api.cloud.yandex.net/v1', model: 'gpt://ВАШ_FOLDER_ID/yandexgpt/latest', needsKey: true, vision: false, hint: 'В названии модели замените ВАШ_FOLDER_ID на идентификатор каталога Yandex Cloud.' },
  { id: 'ollama', kind: 'openai', label: 'Ollama (на своём компьютере)', baseUrl: 'http://localhost:11434/v1', model: 'qwen3', needsKey: false, vision: false, hint: 'Работает без интернета. Установите Ollama и скачайте модель.' },
  { id: 'lmstudio', kind: 'openai', label: 'LM Studio (на своём компьютере)', baseUrl: 'http://localhost:1234/v1', model: 'local-model', needsKey: false, vision: false },
  { id: 'custom', kind: 'openai', label: 'Свой адрес (OpenAI-совместимый)', baseUrl: 'http://localhost:8000/v1', model: '', needsKey: false, vision: false, hint: 'Подходит для любого сервиса с OpenAI-совместимым API.' },
];

export const SPEECH_PROVIDERS = ['openai', 'groq', 'custom'];

export function providerPreset(id: string): ProviderPreset {
  return PROVIDERS.find(p => p.id === id) ?? PROVIDERS[PROVIDERS.length - 1];
}

// Модели, где у Anthropic есть подстраховка на случай отказа (server-side fallback)
export const ANTHROPIC_FALLBACK_MODELS = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'];
