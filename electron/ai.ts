// Встроенный ИИ-помощник: ведёт диалог с выбранной нейросетью и выполняет её команды в редакторе.
import Anthropic from '@anthropic-ai/sdk';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { SYSTEM_PROMPT, TOOLS } from '../shared/tools';
import { ANTHROPIC_FALLBACK_MODELS, providerPreset } from '../shared/providers';
import { getSecret, getSettings } from './settings';
import { callEditor, notify, type ToolOutput } from './bridge';
import { externalTools } from './mcp';
import { dropPhantoms, levels, punctuate } from '../shared/speech';
import { pcm } from './ffmpeg';

interface Session {
  provider: string;
  model: string;
  anthropic: Anthropic.Beta.BetaMessageParam[];
  openai: any[];
}

const sessions = new Map<string, Session>();
let abort: AbortController | null = null;

const emit = (sessionId: string, ev: Record<string, unknown>) => notify('ai:event', { sessionId, ...ev });

function providerConfig() {
  const s = getSettings();
  const preset = providerPreset(s.ai.provider);
  const saved = s.ai.providers[preset.id] || {};
  return {
    preset,
    baseUrl: (saved.baseUrl || preset.baseUrl).replace(/\/+$/, ''),
    model: saved.model || preset.model,
    key: getSecret(preset.id),
  };
}

export function resetSession(sessionId: string): void {
  sessions.delete(sessionId);
}

export function stopAi(): void {
  abort?.abort();
}

async function runTool(name: string, args: any): Promise<ToolOutput> {
  const ext = externalTools().find(t => t.name === name);
  if (ext) {
    try { return await ext.call(args); } catch (e) { return { text: 'Ошибка внешнего инструмента: ' + String(e), isError: true }; }
  }
  if (!TOOLS.some(t => t.name === name)) return { text: `Unknown tool ${name}`, isError: true };
  return callEditor(name, args, 'assistant');
}

export async function chat(sessionId: string, text: string, images: string[] = []): Promise<void> {
  const cfg = providerConfig();
  if (cfg.preset.needsKey && !cfg.key) {
    emit(sessionId, { type: 'error', text: `Нужен ключ для «${cfg.preset.label}». Откройте Настройки → ИИ и вставьте ключ.` });
    emit(sessionId, { type: 'done' });
    return;
  }
  if (!cfg.model) {
    emit(sessionId, { type: 'error', text: 'Не указана модель. Откройте Настройки → ИИ.' });
    emit(sessionId, { type: 'done' });
    return;
  }
  let session = sessions.get(sessionId);
  if (!session || session.provider !== cfg.preset.id || session.model !== cfg.model) {
    session = { provider: cfg.preset.id, model: cfg.model, anthropic: [], openai: [] };
    sessions.set(sessionId, session);
  }
  abort = new AbortController();
  try {
    if (cfg.preset.kind === 'anthropic') await runAnthropic(sessionId, session, cfg, text, images, abort.signal);
    else await runOpenAI(sessionId, session, cfg, text, images, abort.signal);
  } catch (e) {
    if (abort.signal.aborted) emit(sessionId, { type: 'info', text: 'Остановлено' });
    else emit(sessionId, { type: 'error', text: humanError(e) });
  } finally {
    abort = null;
    emit(sessionId, { type: 'done' });
  }
}

function humanError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return 'Ключ Anthropic не подошёл. Проверьте его в настройках.';
  if (e instanceof Anthropic.RateLimitError) return 'Слишком много запросов к Claude. Подождите минуту и попробуйте снова.';
  if (e instanceof Anthropic.NotFoundError) return 'Такой модели нет. Проверьте название модели в настройках.';
  if (e instanceof Anthropic.APIConnectionError) return 'Нет связи с сервером Anthropic. Проверьте интернет.';
  if (e instanceof Anthropic.APIError) return `Ошибка Claude (${e.status}): ${e.message}`;
  const msg = String((e as Error)?.message || e);
  if (/fetch failed|ECONNREFUSED/.test(msg)) return 'Не удалось подключиться к нейросети. Проверьте адрес и интернет (для Ollama и LM Studio — что программа запущена).';
  return msg;
}

function allTools() {
  const ext = externalTools();
  return [
    ...TOOLS.map(t => ({ name: t.name, description: t.description, schema: t.inputSchema })),
    ...ext.map(t => ({ name: t.name, description: t.description, schema: t.inputSchema })),
  ];
}

// Картинка для нейросети: путь к файлу или уже готовые данные base64 (кадр из окна просмотра)
function imageBlock(path: string): { media: string; data: string } {
  if (path.startsWith('data:')) {
    const m = path.match(/^data:([^;]+);base64,(.*)$/s);
    return { media: m?.[1] || 'image/jpeg', data: m?.[2] || '' };
  }
  if (!existsSync(path)) return { media: 'image/jpeg', data: path };
  const ext = path.toLowerCase().split('.').pop();
  const media = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  return { media, data: readFileSync(path).toString('base64') };
}

async function runAnthropic(sessionId: string, s: Session, cfg: ReturnType<typeof providerConfig>, text: string, images: string[], signal: AbortSignal) {
  const client = new Anthropic({ apiKey: cfg.key, baseURL: cfg.baseUrl });
  const content: Anthropic.Beta.BetaContentBlockParam[] = images.map(p => {
    const b = imageBlock(p);
    return { type: 'image', source: { type: 'base64', media_type: b.media as 'image/png', data: b.data } };
  });
  content.push({ type: 'text', text });
  s.anthropic.push({ role: 'user', content });
  const tools = allTools().map(t => ({ name: t.name, description: t.description, input_schema: t.schema as Anthropic.Beta.BetaTool.InputSchema }));
  const fallback = ANTHROPIC_FALLBACK_MODELS.includes(cfg.model) && cfg.baseUrl.includes('api.anthropic.com');

  for (let step = 0; step < 40; step++) {
    emit(sessionId, { type: 'thinking' });
    const res = await client.beta.messages.create({
      model: cfg.model,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages: s.anthropic,
      tools,
      ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    }, { signal });
    // Ответ сохраняем целиком (вместе с блоками размышлений), как требует API
    s.anthropic.push({ role: 'assistant', content: res.content as Anthropic.Beta.BetaContentBlockParam[] });
    if (res.stop_reason === 'refusal') {
      emit(sessionId, { type: 'error', text: 'Нейросеть отказалась выполнять этот запрос. Попробуйте сформулировать иначе.' });
      return;
    }
    const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    for (const b of res.content) if (b.type === 'text' && b.text.trim()) emit(sessionId, { type: 'text', text: b.text });
    if (!uses.length) {
      if (res.stop_reason === 'max_tokens') emit(sessionId, { type: 'info', text: 'Ответ получился слишком длинным и обрезан.' });
      return;
    }
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const u of uses) {
      emit(sessionId, { type: 'tool', id: u.id, name: u.name, args: u.input });
      const out = await runTool(u.name, u.input);
      emit(sessionId, { type: 'tool_done', id: u.id, name: u.name, ok: !out.isError, text: out.text.slice(0, 300), image: out.image ? 'data:image/jpeg;base64,' + out.image : undefined });
      const parts: any[] = [];
      if (out.image) parts.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: out.image } });
      parts.push({ type: 'text', text: out.text.slice(0, 60000) });
      results.push({ type: 'tool_result', tool_use_id: u.id, content: parts, is_error: !!out.isError });
    }
    s.anthropic.push({ role: 'user', content: results });
  }
  emit(sessionId, { type: 'info', text: 'Помощник сделал слишком много шагов подряд и остановился. Напишите «продолжай», если нужно.' });
}

async function runOpenAI(sessionId: string, s: Session, cfg: ReturnType<typeof providerConfig>, text: string, images: string[], signal: AbortSignal) {
  if (!s.openai.length) s.openai.push({ role: 'system', content: SYSTEM_PROMPT });
  if (images.length && cfg.preset.vision) {
    s.openai.push({ role: 'user', content: [{ type: 'text', text }, ...images.map(p => { const b = imageBlock(p); return { type: 'image_url', image_url: { url: `data:${b.media};base64,${b.data}` } }; })] });
  } else {
    s.openai.push({ role: 'user', content: text + (images.length ? `\n(Пользователь приложил картинки: ${images.map(p => basename(p)).join(', ')}, но эта модель не видит изображения.)` : '') });
  }
  const tools = allTools().map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }));
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cfg.key) headers.authorization = 'Bearer ' + cfg.key;
  if (cfg.preset.id === 'openrouter') { headers['HTTP-Referer'] = 'https://github.com/krasking94/kadr-editor'; headers['X-Title'] = 'Hlopushka'; }

  for (let step = 0; step < 40; step++) {
    emit(sessionId, { type: 'thinking' });
    const r = await fetch(cfg.baseUrl + '/chat/completions', {
      method: 'POST', headers, signal,
      body: JSON.stringify({ model: cfg.model, messages: s.openai, tools, tool_choice: 'auto' }),
    });
    const body = await r.text();
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) throw new Error('Ключ не подошёл. Проверьте его в настройках.');
      if (r.status === 404) throw new Error('Модель или адрес не найдены. Проверьте настройки ИИ.');
      throw new Error(`Ошибка сервиса (${r.status}): ${body.slice(0, 300)}`);
    }
    const data = JSON.parse(body);
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error('Нейросеть вернула пустой ответ');
    s.openai.push({ role: 'assistant', content: msg.content ?? '', ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
    if (msg.content?.trim()) emit(sessionId, { type: 'text', text: msg.content });
    if (!msg.tool_calls?.length) return;
    const frames: string[] = [];
    for (const call of msg.tool_calls) {
      let args: any = {};
      try { args = call.function.arguments ? JSON.parse(call.function.arguments) : {}; } catch { args = {}; }
      emit(sessionId, { type: 'tool', id: call.id, name: call.function.name, args });
      const out = await runTool(call.function.name, args);
      emit(sessionId, { type: 'tool_done', id: call.id, name: call.function.name, ok: !out.isError, text: out.text.slice(0, 300), image: out.image ? 'data:image/jpeg;base64,' + out.image : undefined });
      s.openai.push({ role: 'tool', tool_call_id: call.id, content: (out.isError ? 'ERROR: ' : '') + out.text.slice(0, 60000) });
      if (out.image) frames.push(out.image);
    }
    if (frames.length && cfg.preset.vision) {
      s.openai.push({ role: 'user', content: [{ type: 'text', text: 'Rendered frame(s) from get_frame:' }, ...frames.map(f => ({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + f } }))] });
    }
  }
  emit(sessionId, { type: 'info', text: 'Помощник сделал слишком много шагов подряд и остановился. Напишите «продолжай», если нужно.' });
}

// Список моделей сервиса — чтобы не вводить название вручную
export async function listModels(providerId: string, baseUrl?: string): Promise<string[]> {
  const preset = providerPreset(providerId);
  const saved = getSettings().ai.providers[preset.id] || {};
  const url = (baseUrl || saved.baseUrl || preset.baseUrl).replace(/\/+$/, '');
  const key = getSecret(preset.id);
  if (preset.kind === 'anthropic') {
    const client = new Anthropic({ apiKey: key, baseURL: url });
    const out: string[] = [];
    for await (const m of client.models.list()) out.push(m.id);
    return out;
  }
  const r = await fetch(url + '/models', { headers: key ? { authorization: 'Bearer ' + key } : {} });
  if (!r.ok) throw new Error(`Сервис ответил ошибкой ${r.status}`);
  const data = await r.json();
  return (data.data || data.models || []).map((m: any) => m.id || m.name).filter(Boolean).sort();
}

// Простой запрос к выбранной нейросети без инструментов: перевод субтитров, описание ролика, главы
export async function complete(system: string, user: string): Promise<string> {
  const cfg = providerConfig();
  if (cfg.preset.needsKey && !cfg.key) throw new Error(`Нужен ключ для «${cfg.preset.label}». Откройте Настройки → ИИ.`);
  if (!cfg.model) throw new Error('Не указана модель. Откройте Настройки → ИИ.');
  try {
    if (cfg.preset.kind === 'anthropic') {
      const client = new Anthropic({ apiKey: cfg.key, baseURL: cfg.baseUrl });
      const res = await client.messages.create({ model: cfg.model, max_tokens: 16000, system, messages: [{ role: 'user', content: user }] });
      return res.content.map(b => (b.type === 'text' ? b.text : '')).join('').trim();
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cfg.key) headers.authorization = 'Bearer ' + cfg.key;
    const r = await fetch(cfg.baseUrl + '/chat/completions', {
      method: 'POST', headers,
      body: JSON.stringify({ model: cfg.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
    const body = await r.text();
    if (!r.ok) throw new Error(`Ошибка сервиса (${r.status}): ${body.slice(0, 300)}`);
    return String(JSON.parse(body).choices?.[0]?.message?.content || '').trim();
  } catch (e) {
    throw new Error(humanError(e));
  }
}

const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : undefined);

export interface Segment { start: number; end: number; text: string; words?: { s: number; e: number; w: string }[] }

// Подсказка для Whisper: с ней он не выбрасывает «эээ» и «ммм» из расшифровки
const FILLER_PROMPT = 'Эээ, ну, ммм… короче, как бы, это самое. Хм, ну вот.';

// Распознавание речи через OpenAI-совместимый сервис (OpenAI Whisper, Groq и др.)
export async function transcribeFile(path: string, language?: string, fillers = false): Promise<Segment[]> {
  const s = getSettings();
  const preset = providerPreset(s.ai.speechProvider);
  const saved = s.ai.providers[preset.id] || {};
  const url = (saved.baseUrl || preset.baseUrl).replace(/\/+$/, '') + '/audio/transcriptions';
  const key = getSecret(preset.id);
  if (preset.needsKey && !key) throw new Error(`Для распознавания речи нужен ключ «${preset.label}». Откройте Настройки → ИИ.`);
  const form = new FormData();
  form.append('file', new Blob([readFileSync(path)], { type: 'audio/mpeg' }), basename(path));
  form.append('model', s.ai.speechModel || preset.speechModel || 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  form.append('timestamp_granularities[]', 'word');
  if (fillers) form.append('prompt', FILLER_PROMPT);
  if (language || s.ai.speechLanguage) form.append('language', language || s.ai.speechLanguage);
  const r = await fetch(url, { method: 'POST', headers: key ? { authorization: 'Bearer ' + key } : {}, body: form });
  if (!r.ok) throw new Error(`Распознавание не удалось (${r.status}): ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  // Слова со временем: OpenAI и Groq отдают их общим списком, раскладываем по фразам
  const words: { s: number; e: number; w: string }[] = Array.isArray(data.words)
    ? data.words.map((w: any) => ({ s: Number(w.start), e: Number(w.end), w: String(w.word ?? w.text ?? '').trim() })).filter((w: any) => w.w && isFinite(w.s))
    : [];
  if (Array.isArray(data.segments)) {
    const raw = data.segments.map((x: any) => ({
      start: Number(x.start), end: Number(x.end), text: String(x.text).trim(),
      noSpeech: num(x.no_speech_prob), logprob: num(x.avg_logprob), compression: num(x.compression_ratio),
    }));
    // убираем фразы, сказанные «тишиной»: проверяем громкость там, где сервис услышал слова
    const db = levels(await pcm(path, 8000), 8000, 20);
    const segs: Segment[] = dropPhantoms(raw, db, 20).map(({ start, end, text }) => ({ start, end, text }));
    if (words.length) for (const seg of segs) seg.words = punctuate(words.filter(w => w.s >= seg.start - 0.05 && w.s < seg.end - 0.01), seg.text);
    return segs;
  }
  if (data.text) return dropPhantoms([{ start: 0, end: Number(data.duration || 5), text: String(data.text).trim() }], levels(await pcm(path, 8000), 8000, 20), 20);
  return [];
}
