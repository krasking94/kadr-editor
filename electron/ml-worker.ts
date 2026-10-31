// Отдельный процесс для нейросетей на компьютере: распознавание речи (sherpa-onnx) и разделение голоса
// и музыки. Запускается самой программой в режиме Node (ELECTRON_RUN_AS_NODE=1). Если нейросеть упадёт
// или ей не хватит памяти, закроется только этот процесс, а монтаж и проект останутся целы.
import { closeSync, existsSync, openSync, readSync, statSync, writeSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { tokensToWords, type LocalModelId } from '../shared/local-models';

type Req =
  | { id: string; op: 'ping' }
  | { id: string; op: 'asr'; model: LocalModelId; dir: string; input: string; language?: string }
  | { id: string; op: 'separate'; model: LocalModelId; dir: string; input: string; outVoice: string; outMusic: string };

const ML_DIR = process.env.KADR_ML_DIR || '';
const send = (m: unknown) => process.send?.(m);
const threads = Math.max(1, Math.min(8, cpus().length - 1));

if (process.platform === 'win32' && ML_DIR) process.env.PATH = ML_DIR + ';' + (process.env.PATH || '');

let addon: any = null;
const sherpa = () => {
  if (!addon) addon = require(join(ML_DIR, 'sherpa-onnx.node'));
  return addon;
};

// ── Распознавание речи ───────────────────────────────
const recognizers = new Map<string, any>();
function recognizer(model: LocalModelId, dir: string, language: string) {
  const key = model + ':' + language;
  if (recognizers.has(key)) return recognizers.get(key);
  const d = join(dir, model);
  const config = model === 'asr-ru'
    ? {
        featConfig: { sampleRate: 16000, featureDim: 64 },
        modelConfig: {
          transducer: { encoder: join(d, 'encoder.int8.onnx'), decoder: join(d, 'decoder.onnx'), joiner: join(d, 'joiner.onnx') },
          tokens: join(d, 'tokens.txt'), numThreads: threads, modelType: 'nemo_transducer', debug: 0, provider: 'cpu',
        },
        decodingMethod: 'greedy_search',
      }
    : {
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          whisper: { encoder: join(d, 'encoder.int8.onnx'), decoder: join(d, 'decoder.int8.onnx'), language, task: 'transcribe', tailPaddings: -1 },
          tokens: join(d, 'tokens.txt'), numThreads: threads, debug: 0, provider: 'cpu',
        },
        decodingMethod: 'greedy_search',
      };
  // в памяти держим одну модель: вторая заняла бы ещё полгигабайта
  recognizers.clear();
  const r = sherpa().createOfflineRecognizer(config);
  recognizers.set(key, r);
  return r;
}

function recognize(rec: any, samples: Float32Array) {
  const a = sherpa();
  const stream = a.createOfflineStream(rec);
  a.acceptWaveformOffline(stream, { samples, sampleRate: 16000 });
  a.decodeOfflineStream(rec, stream);
  return JSON.parse(a.getOfflineStreamResultAsJson(stream)) as { text: string; tokens?: string[]; timestamps?: number[] };
}

async function asr(req: Extract<Req, { op: 'asr' }>) {
  const a = sherpa();
  const SR = 16000;
  const rec = recognizer(req.model, req.dir, req.language || '');
  const vad = a.createVoiceActivityDetector({
    sileroVad: { model: join(req.dir, 'vad', 'silero_vad.onnx'), threshold: 0.45, minSilenceDuration: 0.3, minSpeechDuration: 0.2, maxSpeechDuration: req.model === 'asr-ru' ? 22 : 28, windowSize: 512 },
    sampleRate: SR, numThreads: 1, provider: 'cpu', debug: 0,
  }, 60);
  const total = statSync(req.input).size / 4;
  const fd = openSync(req.input, 'r');
  const segs: { start: number; end: number; text: string; words?: { s: number; e: number; w: string }[] }[] = [];
  const handle = (seg: { start: number; samples: Float32Array }) => {
    const start = seg.start / SR, dur = seg.samples.length / SR;
    // к фразе добавляем немного тишины по краям: так модель не глотает первый и последний звук
    const padded = new Float32Array(seg.samples.length + 0.2 * SR * 2);
    padded.set(seg.samples, 0.2 * SR);
    const r = recognize(rec, padded);
    const text = String(r.text || '').trim();
    if (!text) return;
    const words = r.tokens?.length && r.timestamps?.length === r.tokens.length
      ? tokensToWords(r.tokens, r.timestamps.map(t => Math.max(0, Math.min(dur, t - 0.2))), dur, start)
      : undefined;
    segs.push({ start: +start.toFixed(3), end: +(start + dur).toFixed(3), text, words });
  };
  const drain = () => {
    while (!a.voiceActivityDetectorIsEmpty(vad)) {
      const s = a.voiceActivityDetectorFront(vad, false);
      a.voiceActivityDetectorPop(vad);
      handle(s);
    }
  };
  try {
    const CH = SR * 16;
    const buf = Buffer.alloc(CH * 4);
    let pos = 0, lastSent = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, pos * 4);
      if (n <= 0) break;
      const f = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(n / 4));
      for (let i = 0; i < f.length; i += 512) a.voiceActivityDetectorAcceptWaveform(vad, f.slice(i, Math.min(f.length, i + 512)));
      drain();
      pos += f.length;
      if (pos - lastSent > SR * 8) { lastSent = pos; send({ id: req.id, type: 'progress', p: Math.min(0.99, pos / Math.max(1, total)) }); }
    }
    a.voiceActivityDetectorFlush(vad);
    drain();
  } finally {
    closeSync(fd);
  }
  return segs;
}

// ── Голос отдельно от музыки ─────────────────────────
let koffi: any = null;
let ssLib: any = null;
const engines = new Map<string, any>();
function loadSeparation() {
  if (!ssLib) {
    sherpa(); // сначала подгружаем библиотеки распознавания: рядом лежат нужные им onnxruntime и c-api
    koffi = require(process.env.KADR_KOFFI || 'koffi');
    const name = process.platform === 'win32' ? 'sherpa-onnx-c-api.dll' : process.platform === 'darwin' ? 'libsherpa-onnx-c-api.dylib' : 'libsherpa-onnx-c-api.so';
    const lib = koffi.load(join(ML_DIR, name));
    koffi.struct('KSpl', { vocals: 'const char *', accompaniment: 'const char *' });
    koffi.struct('KUvr', { model: 'const char *' });
    koffi.struct('KMCfg', { spleeter: 'KSpl', uvr: 'KUvr', num_threads: 'int32_t', debug: 'int32_t', provider: 'const char *' });
    koffi.struct('KCfg', { model: 'KMCfg' });
    koffi.struct('KStem', { samples: 'float **', num_channels: 'int32_t', n: 'int32_t' });
    koffi.struct('KOut', { stems: 'KStem *', num_stems: 'int32_t', sample_rate: 'int32_t' });
    ssLib = {
      create: lib.func('void *SherpaOnnxCreateOfflineSourceSeparation(const KCfg *cfg)'),
      process: lib.func('KOut *SherpaOnnxOfflineSourceSeparationProcess(void *ss, float **samples, int32_t nc, int32_t ns, int32_t sr)'),
      free: lib.func('void SherpaOnnxDestroySourceSeparationOutput(KOut *p)'),
      destroy: lib.func('void SherpaOnnxDestroyOfflineSourceSeparation(void *ss)'),
    };
  }
  return ssLib;
}
function separator(model: LocalModelId, dir: string) {
  loadSeparation();
  if (engines.has(model)) return engines.get(model);
  const d = join(dir, model);
  const fast = model === 'sep-fast';
  const ss = ssLib.create({
    model: {
      spleeter: { vocals: fast ? join(d, 'vocals.int8.onnx') : '', accompaniment: fast ? join(d, 'accompaniment.int8.onnx') : '' },
      uvr: { model: fast ? '' : join(d, 'model.onnx') },
      num_threads: threads, debug: 0, provider: 'cpu',
    },
  });
  if (!ss) throw new Error('Не удалось загрузить нейросеть для разделения звука');
  for (const old of engines.values()) ssLib.destroy(old);
  engines.clear();
  engines.set(model, ss);
  return ss;
}

/** Забыть загруженную нейросеть: следующий кусок загрузит её заново */
function dropSeparator(model: LocalModelId) {
  const ss = engines.get(model);
  if (ss) { ssLib.destroy(ss); engines.delete(model); }
}

function separateChunk(ss: any, L: Float32Array, R: Float32Array): [Float32Array[], Float32Array[]] {
  const out = ssLib.process(ss, [L, R], 2, L.length, 44100);
  if (!out) throw new Error('Нейросеть не смогла обработать звук');
  try {
    const o = koffi.decode(out, 'KOut');
    const stems = koffi.decode(o.stems, 'KStem', o.num_stems);
    return [0, 1].map(k => {
      const st = stems[k];
      const ptrs = koffi.decode(st.samples, 'float *', st.num_channels);
      const arr = koffi.array('float', st.n, 'Typed');
      const ch = ptrs.map((p: unknown) => {
        const full = new Float32Array(L.length); // модель может вернуть чуть короче — дополняем тишиной
        full.set((koffi.decode(p, arr) as Float32Array).subarray(0, L.length));
        return full;
      });
      return ch.length > 1 ? ch : [ch[0], ch[0]];
    }) as [Float32Array[], Float32Array[]];
  } finally {
    ssLib.free(out);
  }
}

async function separate(req: Extract<Req, { op: 'separate' }>) {
  const SR = 44100;
  // MDX-Net внутри программы (режим Electron) падает, если один и тот же экземпляр модели обрабатывает
  // второй кусок. Загрузка занимает доли секунды, поэтому для каждого куска берём свежий экземпляр.
  const fresh = req.model === 'sep-best';
  const N = Math.floor(statSync(req.input).size / 8);
  if (N <= 0) throw new Error('В клипе нет звука');
  // куски небольшие: внутри программы (режим Electron) слишком большой запрос памяти за раз роняет процесс,
  // а нейросеть всё равно режет звук на отрезки по ~6 секунд
  const CHUNK = (req.model === 'sep-fast' ? 20 : 12) * SR, OV = SR;
  const starts: number[] = [];
  for (let s = 0; ; s += CHUNK - OV) {
    if (s + CHUNK >= N) { starts.push(Math.max(0, N - CHUNK)); break; }
    starts.push(s);
  }
  if (starts.length > 1 && starts[starts.length - 1] <= starts[starts.length - 2]) starts.pop();
  const fin = openSync(req.input, 'r');
  const fv = openSync(req.outVoice, 'w');
  const fm = openSync(req.outMusic, 'w');
  const write = (fd: number, ch: Float32Array[], from: number, to: number) => {
    if (to <= from) return;
    const il = new Float32Array((to - from) * 2);
    for (let i = from, j = 0; i < to; i++, j += 2) { il[j] = ch[0][i]; il[j + 1] = ch[1][i]; }
    writeSync(fd, Buffer.from(il.buffer));
  };
  let tail: { v: Float32Array[]; m: Float32Array[]; len: number } | null = null;
  try {
    for (let k = 0; k < starts.length; k++) {
      const st = starts[k];
      const len = Math.min(CHUNK, N - st);
      // очень короткий звук дополняем тишиной: нейросети нужно хотя бы несколько секунд
      const padLen = Math.max(len, 3 * SR);
      const raw = Buffer.alloc(len * 8);
      readSync(fin, raw, 0, raw.length, st * 8);
      const inter = new Float32Array(raw.buffer, raw.byteOffset, len * 2);
      const L = new Float32Array(padLen), R = new Float32Array(padLen);
      for (let i = 0; i < len; i++) { L[i] = inter[2 * i]; R[i] = inter[2 * i + 1]; }
      if (fresh) dropSeparator(req.model);
      const [v, m] = separateChunk(separator(req.model, req.dir), L, R);
      // стык с прошлым куском: плавно переходим от старого результата к новому
      if (tail) {
        const ov = tail.len;
        for (let i = 0; i < ov && i < len; i++) {
          const w = (i + 0.5) / ov;
          for (let c = 0; c < 2; c++) {
            v[c][i] = tail.v[c][i] * (1 - w) + v[c][i] * w;
            m[c][i] = tail.m[c][i] * (1 - w) + m[c][i] * w;
          }
        }
      }
      const next = starts[k + 1];
      const keepFrom = next === undefined ? len : next - st;
      write(fv, v, 0, keepFrom);
      write(fm, m, 0, keepFrom);
      tail = next === undefined ? null : { v: v.map(c => c.slice(keepFrom, len)), m: m.map(c => c.slice(keepFrom, len)), len: len - keepFrom };
      send({ id: req.id, type: 'progress', p: Math.min(0.99, (k + 1) / starts.length) });
    }
  } finally {
    closeSync(fin); closeSync(fv); closeSync(fm);
  }
  return { voice: req.outVoice, music: req.outMusic, samples: N };
}

process.on('message', async (req: Req) => {
  try {
    if (!ML_DIR || !existsSync(join(ML_DIR, 'sherpa-onnx.node'))) throw new Error('Не найдены файлы нейросетей программы. Переустановите «Хлопушку».');
    // ping — проверка при сборке: все библиотеки нейросетей на месте и загружаются
    const result = req.op === 'ping' ? (loadSeparation(), { ok: true, version: sherpa().version ?? '' })
      : req.op === 'asr' ? await asr(req) : await separate(req);
    send({ id: req.id, type: 'done', result });
  } catch (e) {
    send({ id: req.id, type: 'error', error: String((e as Error)?.message || e) });
  }
});
process.on('uncaughtException', e => { send({ type: 'fatal', error: String(e?.message || e) }); });
send({ type: 'ready' });
