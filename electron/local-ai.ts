// Нейросети на компьютере (с 1.0): скачивание моделей, отдельный процесс для их работы,
// распознавание речи без интернета и разделение голоса и музыки.
import { app } from 'electron';
import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, createReadStream, existsSync, mkdirSync, openSync, closeSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asrModelFor, LOCAL_MODELS, localModel, modelBundle, onnxMetaTail, type LocalModelId, type LocalModelStatus } from '../shared/local-models';
import { estimateWords } from '../shared/speech';
import { FFMPEG, run } from './ffmpeg';
import { log } from './crash';

export const modelsDir = () => join(app.getPath('userData'), 'models');
const tempDir = () => { const d = join(tmpdir(), 'kadr'); mkdirSync(d, { recursive: true }); return d; };

// ── Модели на диске ──────────────────────────────────
const filePath = (id: LocalModelId, name: string) => join(modelsDir(), id, name);
// у моделей UVR в конец файла дописаны сведения о себе (см. prepareModel), поэтому файл чуть больше скачанного
const metaTail = (id: LocalModelId) => { const m = localModel(id); return m.uvrMeta ? onnxMetaTail(m.uvrMeta) : null; };
const fileReady = (id: LocalModelId, f: { name: string; size: number }) => {
  try {
    const size = statSync(filePath(id, f.name)).size;
    return size === f.size || size === f.size + (metaTail(id)?.length ?? NaN);
  } catch { return false; }
};

export function localStatus(): LocalModelStatus[] {
  return LOCAL_MODELS.map(m => {
    let bytes = 0;
    for (const f of m.files) {
      try { bytes += Math.min(f.size, statSync(filePath(m.id, f.name)).size); } catch {
        try { bytes += Math.min(f.size, statSync(filePath(m.id, f.name) + '.part').size); } catch { /* ещё не начато */ }
      }
    }
    return { id: m.id, ready: m.files.every(f => fileReady(m.id, f)), bytes, total: m.files.reduce((a, f) => a + f.size, 0) };
  });
}

export const modelReady = (id: LocalModelId) => modelBundle(id).every(m => m.files.every(f => fileReady(m.id, f)));

const downloads = new Map<string, AbortController>();
export const cancelDownload = (jobId: string) => downloads.get(jobId)?.abort();

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(path).on('data', d => hash.update(d)).on('end', () => resolve()).on('error', reject);
  });
  return hash.digest('hex');
}

/** Скачать один файл в .part с докачкой после обрыва связи */
async function fetchFile(url: string, part: string, size: number, signal: AbortSignal, onBytes: (n: number) => void): Promise<void> {
  for (let tries = 0; ; tries++) {
    let have = 0;
    try { have = statSync(part).size; } catch { have = 0; }
    if (have > size) { unlinkSync(part); have = 0; }
    try {
      if (have < size) {
        const r = await fetch(url, { headers: have ? { range: `bytes=${have}-` } : {}, signal, redirect: 'follow' });
        if (!r.ok) throw new Error(`Сервер с моделями ответил ${r.status}`);
        if (have && r.status !== 206) { unlinkSync(part); have = 0; } // докачка не поддерживается — сначала
        const fd = openSync(part, 'a');
        try {
          const reader = r.body!.getReader();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            writeSync(fd, value);
            have += value.length;
            onBytes(have);
          }
        } finally {
          closeSync(fd);
        }
      }
      if (statSync(part).size !== size) throw new Error('Файл скачался не полностью');
      return;
    } catch (e) {
      if (signal.aborted) throw new Error('Отменено');
      if (tries >= 4) throw new Error('Не удалось скачать модель: ' + String((e as Error)?.message || e) + '. Проверьте интернет и попробуйте ещё раз — скачанное не пропадёт.');
      await new Promise(r => setTimeout(r, 1500 * (tries + 1)));
    }
  }
}

/** Скачать модель и всё, без чего она не работает. Докачивает прерванные файлы. */
export async function downloadModel(jobId: string, id: LocalModelId, onProgress: (p: number, text: string) => void): Promise<boolean> {
  const ctrl = new AbortController();
  downloads.set(jobId, ctrl);
  const files = modelBundle(id).flatMap(m => m.files.map(f => ({ m, f })));
  const total = files.reduce((a, x) => a + x.f.size, 0);
  let done = files.filter(x => fileReady(x.m.id, x.f)).reduce((a, x) => a + x.f.size, 0);
  try {
    for (const { m, f } of files) {
      if (fileReady(m.id, f)) continue;
      mkdirSync(join(modelsDir(), m.id), { recursive: true });
      const dest = filePath(m.id, f.name), part = dest + '.part';
      let last = 0;
      await fetchFile(f.url, part, f.size, ctrl.signal, have => {
        const now = Date.now();
        if (now - last > 250) { last = now; onProgress((done + have) / total, `${Math.round((done + have) / 1e6)} из ${Math.round(total / 1e6)} МБ`); }
      });
      onProgress((done + f.size) / total, 'Проверяю файл…');
      if ((await sha256(part)) !== f.sha256) {
        unlinkSync(part);
        throw new Error(`Файл «${f.name}» повреждён при скачивании. Попробуйте ещё раз.`);
      }
      renameSync(part, dest);
      done += f.size;
    }
    prepareModel(id);
    log(`Скачана модель ${id}`);
    onProgress(1, 'Готово');
    return true;
  } finally {
    downloads.delete(jobId);
  }
}

/** Модели UVR нужны сведения о себе внутри файла: дописываем их в конец (один раз, после проверки суммы) */
function prepareModel(id: LocalModelId) {
  for (const m of modelBundle(id)) {
    const tail = metaTail(m.id);
    if (!tail) continue;
    const f = m.files[0], path = filePath(m.id, f.name);
    try { if (statSync(path).size === f.size) appendFileSync(path, tail); } catch { /* файла нет — скачается */ }
  }
}

export function deleteModel(id: LocalModelId) {
  stopWorker();
  rmSync(join(modelsDir(), id), { recursive: true, force: true });
  // поиск речи нужен обеим моделям распознавания: удаляем его, только если больше никому не нужен
  return localStatus();
}

// ── Процесс с нейросетями ────────────────────────────
type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; onProgress?: (p: number) => void };
let worker: ChildProcess | null = null;
let idle: NodeJS.Timeout | null = null;
const pending = new Map<string, Pending>();

function nativeDirs() {
  const plat = process.platform === 'win32' ? 'win' : process.platform;
  const ml = app.isPackaged ? join(process.resourcesPath, 'ml') : join(app.getAppPath(), 'node_modules', `sherpa-onnx-${plat}-${process.arch}`);
  const koffi = app.isPackaged ? join(process.resourcesPath, 'ml', 'koffi.node') : join(app.getAppPath(), 'node_modules', 'koffi', 'build', 'koffi', `${process.platform}_${process.arch}`, 'koffi.node');
  return { ml, koffi };
}

function ensureWorker(): ChildProcess {
  if (idle) { clearTimeout(idle); idle = null; }
  if (worker && worker.connected) return worker;
  const { ml, koffi } = nativeDirs();
  // в собранной программе процесс лежит рядом с ресурсами, а не внутри app.asar
  const script = app.isPackaged ? join(process.resourcesPath, 'ml-worker.js') : join(__dirname, 'ml-worker.js');
  const w = fork(script, [], {
    execPath: process.execPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', KADR_ML_DIR: ml, KADR_KOFFI: koffi },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true,
  } as any);
  let stderr = '';
  w.stderr?.on('data', d => { stderr = (stderr + d.toString()).slice(-4000); });
  w.on('message', (m: any) => {
    if (m?.type === 'fatal') { log('Сбой в нейросети: ' + m.error); return; }
    const p = m?.id ? pending.get(m.id) : undefined;
    if (!p) return;
    if (m.type === 'progress') p.onProgress?.(m.p);
    else if (m.type === 'done') { pending.delete(m.id); p.resolve(m.result); scheduleIdle(); }
    else if (m.type === 'error') { pending.delete(m.id); p.reject(new Error(m.error)); scheduleIdle(); }
  });
  w.on('exit', (code, signal) => {
    if (worker === w) worker = null;
    if (pending.size) {
      const why = signal === 'SIGKILL' || code === null ? '' : stderr.split('\n').filter(Boolean).slice(-2).join(' ');
      log(`Процесс нейросетей закрылся (${code ?? signal}) ${why}`);
      for (const [id, p] of pending) { pending.delete(id); p.reject(new Error(why ? `Нейросеть остановилась: ${why.slice(0, 300)}` : 'Нейросеть остановилась. Возможно, не хватило памяти — закройте другие программы и попробуйте ещё раз.')); }
    }
  });
  worker = w;
  return w;
}

function scheduleIdle() {
  if (idle) clearTimeout(idle);
  // модель занимает сотни мегабайт памяти: если ей три минуты не пользуются, освобождаем
  idle = setTimeout(() => { if (!pending.size) stopWorker(); }, 3 * 60 * 1000);
}

export function stopWorker() {
  if (idle) { clearTimeout(idle); idle = null; }
  const w = worker;
  worker = null;
  if (w) { try { w.kill('SIGKILL'); } catch { /* уже закрыт */ } }
}

function call<T>(req: Record<string, unknown>, onProgress?: (p: number) => void, signal?: AbortSignal): Promise<T> {
  const id = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Отменено')); return; }
    pending.set(id, { resolve, reject, onProgress });
    signal?.addEventListener('abort', () => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error('Отменено'));
      stopWorker(); // нейросеть не умеет останавливаться на полпути — закрываем её процесс
    });
    ensureWorker().send({ ...req, id, dir: modelsDir() });
  });
}

// ── Распознавание речи ───────────────────────────────
export type LocalSegment = { start: number; end: number; text: string; words?: { s: number; e: number; w: string }[] };

// Текст ошибки понятен человеку, а метка [MODEL:…] подсказывает окну программы, что предложить скачать
export class ModelMissingError extends Error {
  constructor(public model: LocalModelId) {
    super(`Сначала нужно один раз скачать нейросеть «${localModel(model).title}»: Настройки → «На компьютере». [MODEL:${model}]`);
  }
}

/** Распознать речь в файле на компьютере. Файл может быть любым: звук достаётся через FFmpeg. */
export async function localTranscribe(path: string, language: string | undefined, onProgress?: (p: number) => void, signal?: AbortSignal): Promise<LocalSegment[]> {
  const model = asrModelFor(language);
  if (!modelReady(model)) throw new ModelMissingError(model);
  const raw = join(tempDir(), `asr_${Date.now().toString(36)}.f32`);
  try {
    const r = await run(FFMPEG, ['-hide_banner', '-y', '-nostdin', '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', raw], { signal });
    if (signal?.aborted) throw new Error('Отменено');
    if (r.code !== 0 || !existsSync(raw)) throw new Error('Не удалось достать звук из файла');
    const segs = await call<LocalSegment[]>({ op: 'asr', model, input: raw, language: language || '' }, onProgress, signal);
    return segs.map(s => ({ ...s, words: s.words?.length ? s.words : estimateWords(s.text, s.start, s.end) }));
  } finally {
    try { unlinkSync(raw); } catch { /* уже удалён */ }
  }
}

/** Проверка при сборке: процесс нейросетей запускается и находит все свои библиотеки */
export async function localSelfTest(): Promise<{ ok: boolean; version?: string; error?: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await call<{ ok: boolean; version: string }>({ op: 'ping' }, undefined, ctrl.signal);
    return { ok: !!r.ok, version: r.version };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  } finally {
    clearTimeout(t);
    stopWorker();
  }
}

// ── Голос отдельно от музыки ─────────────────────────
const sepJobs = new Map<string, AbortController>();
export const cancelSeparate = (jobId: string) => sepJobs.get(jobId)?.abort();

export async function localSeparate(jobId: string, path: string, from: number, to: number, quality: 'fast' | 'best', onProgress: (p: number) => void): Promise<{ voice: string; music: string }> {
  const model: LocalModelId = quality === 'fast' ? 'sep-fast' : 'sep-best';
  if (!modelReady(model)) throw new ModelMissingError(model);
  prepareModel(model);
  const ctrl = new AbortController();
  sepJobs.set(jobId, ctrl);
  const dir = join(app.getPath('documents'), 'Хлопушка', 'Обработка');
  mkdirSync(dir, { recursive: true });
  const stamp = Date.now().toString(36);
  const raw = join(tempDir(), `sep_${stamp}.f32`), rv = raw + '.voice', rm = raw + '.music';
  const base = (path.split(/[\\/]/).pop() || 'Звук').replace(/\.[^.]+$/, '').slice(0, 60);
  const voice = join(dir, `${base} — голос ${stamp}.flac`), music = join(dir, `${base} — музыка ${stamp}.flac`);
  try {
    onProgress(0.01);
    const len = Math.max(0.1, to - from);
    const r = await run(FFMPEG, ['-hide_banner', '-y', '-nostdin', '-ss', String(from), '-t', String(len), '-i', path, '-vn', '-ac', '2', '-ar', '44100', '-f', 'f32le', raw], { signal: ctrl.signal });
    if (ctrl.signal.aborted) throw new Error('Отменено');
    if (r.code !== 0 || !existsSync(raw)) throw new Error('Не удалось достать звук из клипа');
    await call({ op: 'separate', model, input: raw, outVoice: rv, outMusic: rm }, p => onProgress(0.03 + p * 0.9), ctrl.signal);
    for (const [src, dst] of [[rv, voice], [rm, music]]) {
      const e = await run(FFMPEG, ['-hide_banner', '-y', '-nostdin', '-f', 'f32le', '-ar', '44100', '-ac', '2', '-i', src, '-c:a', 'flac', dst], { signal: ctrl.signal });
      if (e.code !== 0) throw new Error('Не удалось сохранить звук');
    }
    onProgress(1);
    log(`Голос отделён от музыки (${model}, ${Math.round(len)} с)`);
    return { voice, music };
  } finally {
    sepJobs.delete(jobId);
    for (const f of [raw, rv, rm]) try { unlinkSync(f); } catch { /* нет файла */ }
  }
}

export const localModelsInfo = () => ({ dir: modelsDir(), models: LOCAL_MODELS.map(m => ({ ...m, files: undefined })), status: localStatus() });
export { localModel };
