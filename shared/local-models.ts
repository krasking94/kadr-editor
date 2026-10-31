// Нейросети, которые работают прямо на компьютере, без интернета и без ключей (с 1.0).
// Файлы скачиваются один раз в папку программы. Адреса закреплены на определённой версии файлов,
// а размер и контрольная сумма проверяются после скачивания, чтобы никто не подменил модель.

export type LocalModelId = 'vad' | 'asr-ru' | 'asr-multi' | 'sep-fast' | 'sep-best';

export interface LocalModelFile {
  name: string; // как файл называется на диске
  url: string; // откуда качать (адрес закреплён на версии)
  size: number; // байты
  sha256: string;
}

export interface LocalModel {
  id: LocalModelId;
  title: string;
  what: string; // для чего, простыми словами
  license: string;
  files: LocalModelFile[];
  needs?: LocalModelId[]; // что ещё нужно скачать вместе с ней
  // для моделей UVR (MDX-Net): сведения, которые программа дописывает в файл, чтобы его понял sherpa-onnx
  uvrMeta?: Record<string, string | number>;
}

const hf = (repo: string, rev: string, file: string) => `https://huggingface.co/${repo}/resolve/${rev}/${file}`;

const GIGA = 'csukuangfj/sherpa-onnx-nemo-transducer-punct-giga-am-v3-russian-2025-12-16';
const GIGA_REV = 'a6039be7cee829a9044a69ac0ebaf1c191217c97';
const WHISPER = 'csukuangfj/sherpa-onnx-whisper-small';
const WHISPER_REV = '8f3c18b358db4d1f2fc1eae49d75cd20989e4309';
const SPLEETER = 'csukuangfj/sherpa-onnx-spleeter-2stems-int8';
const SPLEETER_REV = 'f315b4e699f7eab644977c7e69988733d877f6ee';
const KIM = 'diarizeapp/uvr-kim-vocal-2';
const KIM_REV = 'e24eb91da6035652bf05d6d721bf83da24fe782c';
const VAD = 'onnx-community/silero-vad';
const VAD_REV = 'e71cae966052b992a7eca6b17738916ce0eca4ec';

export const LOCAL_MODELS: LocalModel[] = [
  {
    id: 'vad', title: 'Поиск речи (Silero VAD)', what: 'Находит, где в записи говорят, чтобы не распознавать тишину и музыку.', license: 'лицензия MIT',
    files: [{ name: 'silero_vad.onnx', url: hf(VAD, VAD_REV, 'onnx/model.onnx'), size: 2243022, sha256: 'a4a068cd6cf1ea8355b84327595838ca748ec29a25bc91fc82e6c299ccdc5808' }],
  },
  {
    id: 'asr-ru', title: 'Русская речь (GigaAM v3)', what: 'Распознаёт русскую речь с запятыми и точками. Работает быстрее, чем длится запись.', license: 'лицензия MIT (Сбер, GigaChat Team)',
    needs: ['vad'],
    files: [
      { name: 'encoder.int8.onnx', url: hf(GIGA, GIGA_REV, 'encoder.int8.onnx'), size: 224570820, sha256: '369f35a71bf288d3b8e0391fabd8dba5f2314088d440bca474056b7b4b6e66bf' },
      { name: 'decoder.onnx', url: hf(GIGA, GIGA_REV, 'decoder.onnx'), size: 4600132, sha256: '38fc7475443ea2a26f63211ca350f73ac50fff824ab7a3876ee2bd610c53bbc4' },
      { name: 'joiner.onnx', url: hf(GIGA, GIGA_REV, 'joiner.onnx'), size: 2712896, sha256: '602ff7017a93311aad34df1437c8d7f49911353c13d6eae7a6ee7b041339465c' },
      { name: 'tokens.txt', url: hf(GIGA, GIGA_REV, 'tokens.txt'), size: 13354, sha256: '39abae20e692998290c574e606f11a9edef2902a1995463fcff63d1490cf22b7' },
    ],
  },
  {
    id: 'asr-multi', title: 'Другие языки (Whisper small)', what: 'Английский, украинский, казахский, немецкий и ещё 90 языков. Медленнее русской модели.', license: 'лицензия MIT (OpenAI)',
    needs: ['vad'],
    files: [
      { name: 'encoder.int8.onnx', url: hf(WHISPER, WHISPER_REV, 'small-encoder.int8.onnx'), size: 112442483, sha256: '4cbe7b22fa9026b843b60a68640c747de05bafb1a11b57edc0e66c232d9f33a9' },
      { name: 'decoder.int8.onnx', url: hf(WHISPER, WHISPER_REV, 'small-decoder.int8.onnx'), size: 262226114, sha256: 'acad50b5c782696e91b55914cc5ab4f756f1532f76e22aa6fc615f39fb69a8ee' },
      { name: 'tokens.txt', url: hf(WHISPER, WHISPER_REV, 'small-tokens.txt'), size: 816730, sha256: 'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126' },
    ],
  },
  {
    id: 'sep-fast', title: 'Голос и музыка — быстро (Spleeter)', what: 'Делит звук на голос и всё остальное. Минута звука — за несколько секунд.', license: 'лицензия MIT (Deezer)',
    files: [
      { name: 'vocals.int8.onnx', url: hf(SPLEETER, SPLEETER_REV, 'vocals.int8.onnx'), size: 26238864, sha256: '6e9721864c0c1a6d86eaae92de71637b2daeb3df769c9c536053b46be8dd10aa' },
      { name: 'accompaniment.int8.onnx', url: hf(SPLEETER, SPLEETER_REV, 'accompaniment.int8.onnx'), size: 26238869, sha256: '53a96a0d1520b45b8f3cc53262e3725defb686fc3a17490932f050721f4583f1' },
    ],
  },
  {
    id: 'sep-best', title: 'Голос и музыка — качественно (MDX-Net Kim Vocal 2)', what: 'Чище отделяет голос, но работает примерно со скоростью самой записи.', license: 'модель сообщества Ultimate Vocal Remover',
    files: [{ name: 'model.onnx', url: hf(KIM, KIM_REV, 'Kim_Vocal_2.onnx'), size: 66759214, sha256: 'ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b' }],
    uvrMeta: { model_type: 'UVR', stems: 2, sample_rate: 44100, n_fft: 7680, center: 1, win_length: 7680, hop_length: 1024, dim_t: 256, dim_f: 3072, dim_c: 4, window_type: 'hann' },
  },
];

export const localModel = (id: LocalModelId) => LOCAL_MODELS.find(m => m.id === id)!;

/** Сколько всего нужно скачать для модели вместе с тем, без чего она не работает */
export function modelBundle(id: LocalModelId): LocalModel[] {
  const m = localModel(id);
  return [...(m.needs || []).map(localModel), m];
}

export const bundleSize = (id: LocalModelId) => modelBundle(id).reduce((s, m) => s + m.files.reduce((a, f) => a + f.size, 0), 0);

/** Какая модель распознаёт этот язык на компьютере */
export const asrModelFor = (language: string | undefined): LocalModelId => (!language || language === 'ru' ? 'asr-ru' : 'asr-multi');

export const mb = (bytes: number) => `${Math.round(bytes / 1e6)} МБ`;

export interface LocalModelStatus {
  id: LocalModelId;
  ready: boolean; // все файлы на месте
  bytes: number; // сколько уже скачано
  total: number;
}

// Слова из кусочков (токенов) модели: кусочек с пробелом в начале начинает новое слово.
// times — время начала каждого кусочка (секунды от начала фразы), end — конец фразы.
export function tokensToWords(tokens: string[], times: number[], end: number, offset = 0): { s: number; e: number; w: string }[] {
  const words: { s: number; e: number; w: string; last: number }[] = [];
  let startNew = true;
  tokens.forEach((tok, i) => {
    const t = Number.isFinite(times[i]) ? times[i] : (words.length ? words[words.length - 1].last : 0);
    if (/^\s/.test(tok)) startNew = true;
    const text = tok.replace(/^\s+/, '');
    if (!text) return; // одинокий пробел: следующий кусочек начнёт слово
    const punct = /^[.,!?;:…»)"'\-–—]+$/.test(text);
    if (startNew && !(punct && words.length)) {
      words.push({ s: t, e: t, w: text, last: t });
    } else if (words.length) {
      const w = words[words.length - 1];
      w.w += text;
      w.last = t;
    } else {
      words.push({ s: t, e: t, w: text, last: t });
    }
    startNew = false;
  });
  return words.map((w, i) => {
    const next = words[i + 1]?.s ?? end;
    const e = Math.max(w.last + 0.08, Math.min(next - 0.02, w.last + 0.6));
    return { s: +(w.s + offset).toFixed(3), e: +(Math.min(e, end) + offset).toFixed(3), w: w.w };
  }).filter(w => w.w);
}

// Дописывает в файл ONNX сведения (metadata_props, поле 14 ModelProto). В protobuf повторяющиеся поля можно
// просто добавить в конец файла, поэтому сам файл модели не разбирается и не пересобирается.
export function onnxMetaTail(meta: Record<string, string | number>): Uint8Array {
  const varint = (n: number) => { const b: number[] = []; while (n > 127) { b.push((n & 127) | 128); n >>>= 7; } b.push(n); return b; };
  const enc = (s: string) => Array.from(new TextEncoder().encode(s));
  const field = (tag: number, bytes: number[]) => [tag, ...varint(bytes.length), ...bytes];
  const out: number[] = [];
  for (const [k, v] of Object.entries(meta)) out.push(...field(0x72, [...field(0x0a, enc(k)), ...field(0x12, enc(String(v)))]));
  return new Uint8Array(out);
}
