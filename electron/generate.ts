// Генерация картинок и звука. Готовые файлы складываются в «Документы/Хлопушка/Сгенерировано»,
// а редактор сразу добавляет их в проект.
import { app } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { imageProvider, type Aspect, type GenResult, type Voice } from '../shared/generators';
import { getSecret, getSettings } from './settings';

const outDir = () => {
  const d = join(app.getPath('documents'), 'Хлопушка', 'Сгенерировано');
  mkdirSync(d, { recursive: true });
  return d;
};

/** Понятное имя файла из запроса: «Картинка — кот в космосе 14-05-12.png» */
function save(kind: string, prompt: string, ext: string, data: Buffer): GenResult {
  const words = prompt.replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').trim().split(/\s+/).slice(0, 6).join(' ').slice(0, 48);
  const t = new Date();
  const stamp = [t.getHours(), t.getMinutes(), t.getSeconds()].map(x => String(x).padStart(2, '0')).join('-');
  const name = `${kind} — ${words || 'без названия'} ${stamp}.${ext}`;
  const path = join(outDir(), name);
  writeFileSync(path, data);
  return { path, name };
}

async function failText(r: Response, service: string): Promise<string> {
  const body = (await r.text().catch(() => '')).slice(0, 400);
  if (r.status === 401 || r.status === 403) return `${service}: ключ не подходит или у него нет доступа (${r.status}). ${body}`;
  if (r.status === 402 || r.status === 429 || /quota|credit|balance|insufficient/i.test(body)) return `${service}: закончились деньги или кредиты на счёте, либо слишком много запросов подряд (${r.status}). ${body}`;
  if (r.status === 404) return `${service}: такой модели нет (${r.status}). Проверьте поле «Модель» в настройках. ${body}`;
  return `${service}: ошибка ${r.status}. ${body}`;
}

async function download(url: string): Promise<{ data: Buffer; mime: string }> {
  if (url.startsWith('data:')) {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
    if (!m) throw new Error('Непонятный ответ сервиса');
    return { data: Buffer.from(m[3], m[2] ? 'base64' : 'utf8'), mime: m[1] || 'image/png' };
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Не удалось скачать картинку (${r.status})`);
  return { data: Buffer.from(await r.arrayBuffer()), mime: r.headers.get('content-type') || 'image/png' };
}

const extOf = (mime: string) => (/jpe?g/.test(mime) ? 'jpg' : /webp/.test(mime) ? 'webp' : 'png');

// ── Картинки ──────────────────────────────────────────
export async function generateImage(prompt: string, aspect: Aspect = '16:9', providerId?: string): Promise<GenResult> {
  if (!prompt.trim()) throw new Error('Опишите, какую картинку нужно создать');
  const s = getSettings();
  const p = imageProvider(providerId || s.gen.imageProvider);
  const model = s.gen.imageModels[p.id] || p.model;
  const base = (p.id === 'custom-image' ? s.gen.imageBaseUrl || p.baseUrl : p.baseUrl).replace(/\/+$/, '');
  const key = getSecret(p.keyId);
  if (!key && p.id !== 'custom-image') throw new Error(`Для картинок через «${p.label}» нужен ключ. Откройте Настройки → Картинки и звук.`);

  if (p.api === 'openai') {
    const size = aspect === '1:1' ? '1024x1024' : aspect === '9:16' || aspect === '3:4' ? '1024x1536' : '1536x1024';
    const r = await fetch(base + '/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) },
      body: JSON.stringify({ model, prompt, size, n: 1 }),
    });
    if (!r.ok) throw new Error(await failText(r, p.label));
    const d = (await r.json()).data?.[0];
    if (d?.b64_json) return save('Картинка', prompt, 'png', Buffer.from(d.b64_json, 'base64'));
    if (d?.url) { const f = await download(d.url); return save('Картинка', prompt, extOf(f.mime), f.data); }
    throw new Error(`${p.label}: сервис не вернул картинку`);
  }

  if (p.api === 'gemini') {
    const r = await fetch(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: aspect } },
      }),
    });
    if (!r.ok) throw new Error(await failText(r, p.label));
    const j = await r.json();
    const parts: any[] = j.candidates?.[0]?.content?.parts || [];
    const img = parts.map(x => x.inlineData || x.inline_data).find(x => x?.data);
    if (!img) {
      const said = parts.map(x => x.text).filter(Boolean).join(' ').slice(0, 300);
      throw new Error(`${p.label}: картинка не получилась. ${said || j.promptFeedback?.blockReason || ''}`);
    }
    const mime = img.mimeType || img.mime_type || 'image/png';
    return save('Картинка', prompt, extOf(mime), Buffer.from(img.data, 'base64'));
  }

  // fal.ai: синхронный вызов любой модели по её имени
  const sizes: Record<string, string> = { '16:9': 'landscape_16_9', '9:16': 'portrait_16_9', '1:1': 'square_hd', '4:3': 'landscape_4_3', '3:4': 'portrait_4_3' };
  const r = await fetch(`${base}/${model.replace(/^\/+/, '')}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Key ' + key },
    body: JSON.stringify({ prompt, image_size: sizes[aspect] || 'landscape_16_9', num_images: 1 }),
  });
  if (!r.ok) throw new Error(await failText(r, p.label));
  const j = await r.json();
  const url = j.images?.[0]?.url || j.image?.url;
  if (!url) throw new Error(`${p.label}: сервис не вернул картинку`);
  const f = await download(url);
  return save('Картинка', prompt, extOf(f.mime), f.data);
}

// ── Звук: ElevenLabs ──────────────────────────────────
const EL = 'https://api.elevenlabs.io';
function elKey(): string {
  const k = getSecret('elevenlabs');
  if (!k) throw new Error('Для голоса, звуков и музыки нужен ключ ElevenLabs. Откройте Настройки → Картинки и звук.');
  return k;
}

async function elAudio(path: string, body: unknown, kind: string, prompt: string): Promise<GenResult> {
  const r = await fetch(`${EL}${path}${path.includes('?') ? '&' : '?'}output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'xi-api-key': elKey(), accept: 'audio/mpeg' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await failText(r, 'ElevenLabs'));
  return save(kind, prompt, 'mp3', Buffer.from(await r.arrayBuffer()));
}

export async function listVoices(): Promise<Voice[]> {
  const r = await fetch(`${EL}/v2/voices?page_size=100`, { headers: { 'xi-api-key': elKey() } });
  if (!r.ok) throw new Error(await failText(r, 'ElevenLabs'));
  const j = await r.json();
  return (j.voices || []).map((v: any) => {
    const l = v.labels || {};
    const AGE: Record<string, string> = { young: 'молодой', 'middle aged': 'средних лет', middle_aged: 'средних лет', old: 'пожилой' };
    const info = [l.gender === 'female' ? 'женский' : l.gender === 'male' ? 'мужской' : '', AGE[l.age] ?? l.age, l.accent || l.language, v.category === 'cloned' ? 'ваш клон' : v.category === 'generated' ? 'создан вами' : '']
      .filter(Boolean).join(', ');
    return { id: v.voice_id, name: v.name, info, preview: v.preview_url || undefined };
  });
}

export async function generateSpeech(text: string, voiceId?: string, model?: string): Promise<GenResult> {
  if (!text.trim()) throw new Error('Нет текста для озвучки');
  const s = getSettings();
  let voice = voiceId || s.gen.voiceId;
  if (!voice) voice = (await listVoices())[0]?.id || '';
  if (!voice) throw new Error('В ElevenLabs нет ни одного голоса. Добавьте голос на сайте elevenlabs.io.');
  return elAudio(`/v1/text-to-speech/${encodeURIComponent(voice)}`, { text, model_id: model || s.gen.ttsModel || 'eleven_v4' }, 'Голос', text);
}

export function generateSoundEffect(prompt: string, duration?: number): Promise<GenResult> {
  if (!prompt.trim()) throw new Error('Опишите звук');
  const body: Record<string, unknown> = { text: prompt };
  if (duration) body.duration_seconds = Math.max(0.5, Math.min(30, duration));
  return elAudio('/v1/sound-generation', body, 'Звук', prompt);
}

export function generateMusic(prompt: string, duration = 30, instrumental = true): Promise<GenResult> {
  if (!prompt.trim()) throw new Error('Опишите музыку');
  const ms = Math.round(Math.max(3, Math.min(300, duration)) * 1000);
  return elAudio('/v1/music', { prompt, music_length_ms: ms, force_instrumental: instrumental }, 'Музыка', prompt);
}
