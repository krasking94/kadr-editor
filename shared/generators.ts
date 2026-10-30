// Генерация прямо в «Кадре»: картинки (разные сервисы) и звук (ElevenLabs: голос, звуковые эффекты, музыка).

export type ImageApi = 'openai' | 'gemini' | 'fal';

export interface ImageProvider {
  id: string;
  api: ImageApi;
  label: string;
  keyId: string; // под каким именем хранится ключ (общий с помощником, если сервис тот же)
  baseUrl: string;
  model: string;
  keyUrl?: string;
  price: string;
  hint?: string;
}

export const IMAGE_PROVIDERS: ImageProvider[] = [
  { id: 'openai', api: 'openai', label: 'OpenAI (GPT Image)', keyId: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-2', keyUrl: 'https://platform.openai.com/api-keys', price: 'примерно 1–20 ₽ за картинку, зависит от качества', hint: 'Хорошо понимает сложные просьбы и пишет текст на картинках.' },
  { id: 'gemini', api: 'gemini', label: 'Google (Nano Banana)', keyId: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-nano-banana-2.1', keyUrl: 'https://aistudio.google.com/apikey', price: 'примерно 3–15 ₽ за картинку', hint: 'Быстрая и очень качественная. Ключ тот же, что у Gemini.' },
  { id: 'fal', api: 'fal', label: 'FLUX (fal.ai)', keyId: 'fal', baseUrl: 'https://fal.run', model: 'fal-ai/flux/schnell', keyUrl: 'https://fal.ai/dashboard/keys', price: 'меньше 1 ₽ за картинку', hint: 'Самый дешёвый и быстрый. В поле «Модель» можно указать любую модель fal.ai, например fal-ai/flux-pro/v1.1.' },
  { id: 'custom-image', api: 'openai', label: 'Свой адрес (OpenAI-совместимый)', keyId: 'custom-image', baseUrl: 'http://localhost:8000/v1', model: '', price: 'зависит от сервиса', hint: 'Любой сервис с методом /images/generations: Together, локальные модели и другие.' },
];

export const imageProvider = (id: string) => IMAGE_PROVIDERS.find(p => p.id === id) ?? IMAGE_PROVIDERS[0];

export const ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4'] as const;
export type Aspect = (typeof ASPECTS)[number];

export const ELEVEN_TTS_MODELS = [
  { id: 'eleven_v4', label: 'v4 — самая живая речь' },
  { id: 'eleven_multilingual_v2', label: 'Multilingual v2 — стабильная' },
  { id: 'eleven_flash_v2_5', label: 'Flash 2.5 — быстрая и дешёвая' },
];

export interface Voice { id: string; name: string; info: string; preview?: string }

export interface GenResult { path: string; name: string }
