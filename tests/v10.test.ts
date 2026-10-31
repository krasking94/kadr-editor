// Проверки версии 1.0: нейросети на компьютере — каталог моделей, слова из кусочков распознавания,
// сведения для моделей UVR внутри файла ONNX.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asrModelFor, bundleSize, LOCAL_MODELS, localModel, modelBundle, onnxMetaTail, tokensToWords } from '../shared/local-models';

test('каталог моделей: адреса закреплены на версии, суммы и размеры на месте', () => {
  const ids = new Set<string>();
  for (const m of LOCAL_MODELS) {
    assert.ok(!ids.has(m.id), 'повтор ' + m.id);
    ids.add(m.id);
    assert.ok(m.title && m.what && m.license, m.id);
    assert.ok(m.files.length > 0, m.id);
    const names = new Set<string>();
    for (const f of m.files) {
      assert.match(f.url, /^https:\/\/huggingface\.co\/[\w.-]+\/[\w.-]+\/resolve\/[0-9a-f]{40}\//, f.url);
      assert.match(f.sha256, /^[0-9a-f]{64}$/, f.name);
      assert.ok(f.size > 1000, f.name);
      assert.ok(!names.has(f.name), 'повтор файла ' + f.name);
      names.add(f.name);
    }
    for (const n of m.needs || []) assert.ok(LOCAL_MODELS.some(x => x.id === n), `${m.id} нуждается в неизвестной ${n}`);
  }
});

test('распознавание речи всегда скачивается вместе с поиском речи', () => {
  assert.equal(asrModelFor('ru'), 'asr-ru');
  assert.equal(asrModelFor(''), 'asr-ru');
  assert.equal(asrModelFor(undefined), 'asr-ru');
  assert.equal(asrModelFor('en'), 'asr-multi');
  assert.equal(asrModelFor('uk'), 'asr-multi');
  for (const id of ['asr-ru', 'asr-multi'] as const) {
    assert.deepEqual(modelBundle(id).map(m => m.id), ['vad', id]);
    const sum = [localModel('vad'), localModel(id)].reduce((a, m) => a + m.files.reduce((b, f) => b + f.size, 0), 0);
    assert.equal(bundleSize(id), sum);
  }
  assert.deepEqual(modelBundle('sep-best').map(m => m.id), ['sep-best']);
});

test('слова из кусочков: пробел начинает слово, знаки препинания прилипают', () => {
  const w = tokensToWords([' При', 'вет', ',', ' мир', '.'], [0, 0.2, 0.4, 0.6, 0.9], 1.2, 10);
  assert.deepEqual(w.map(x => x.w), ['Привет,', 'мир.']);
  assert.equal(w[0].s, 10);
  assert.equal(w[1].s, 10.6);
  // конец слова — чуть раньше начала следующего, но не раньше последнего кусочка
  assert.ok(w[0].e > 10.4 && w[0].e <= 10.6, String(w[0].e));
  assert.ok(w[1].e > 10.9 && w[1].e <= 11.2, String(w[1].e));
});

test('слова из кусочков: одинокий пробел, первое слово без пробела, пустые кусочки', () => {
  const w = tokensToWords(['да', ' ', 'нет', '', ' ну', '…'], [0, 0.3, 0.35, 0.5, 0.6, 0.8], 1);
  assert.deepEqual(w.map(x => x.w), ['да', 'нет', 'ну…']);
  for (let i = 1; i < w.length; i++) assert.ok(w[i].s >= w[i - 1].s);
  for (const x of w) assert.ok(x.e > x.s && x.e <= 1);
  // знак препинания в самом начале не теряется
  assert.deepEqual(tokensToWords(['—', ' да'], [0, 0.2], 0.5).map(x => x.w), ['—', 'да']);
  // время у кусочка может отсутствовать — берётся время предыдущего
  const n = tokensToWords([' раз', ' два'], [0.1, NaN], 1);
  assert.equal(n.length, 2);
  assert.ok(Number.isFinite(n[1].s));
});

// Простой разбор protobuf: ключ-значение из поля 14 (metadata_props) модели ONNX
function readMeta(bytes: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  const varint = () => { let n = 0, sh = 0, b: number; do { b = bytes[i++]; n |= (b & 127) << sh; sh += 7; } while (b & 128); return n; };
  const dec = new TextDecoder();
  while (i < bytes.length) {
    assert.equal(bytes[i++], 0x72, 'поле 14, длина');
    const end = varint() + i;
    let k = '', v = '';
    while (i < end) {
      const tag = bytes[i++];
      const len = varint();
      const s = dec.decode(bytes.slice(i, i + len));
      i += len;
      if (tag === 0x0a) k = s; else if (tag === 0x12) v = s; else assert.fail('неизвестное поле ' + tag);
    }
    out[k] = v;
  }
  return out;
}

test('сведения для модели UVR дописываются в конец файла в формате ONNX', () => {
  assert.deepEqual(Array.from(onnxMetaTail({ a: 'b' })), [0x72, 6, 0x0a, 1, 97, 0x12, 1, 98]);
  const meta = localModel('sep-best').uvrMeta!;
  assert.equal(meta.model_type, 'UVR'); // без этого sherpa-onnx не понимает, что это за модель
  const back = readMeta(onnxMetaTail(meta));
  assert.deepEqual(back, Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, String(v)])));
  // длинные значения (больше 127 байт) кодируются несколькими байтами длины
  const long = 'я'.repeat(100);
  assert.deepEqual(readMeta(onnxMetaTail({ key: long })), { key: long });
});
