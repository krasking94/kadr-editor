// Проверки версии 0.4: свободные окна и ключевые кадры.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultLayout } from '../shared/settings';
import { docksOf, homeTarget, mirror, movePane } from '../shared/layout';
import { keysOf, removeKey, setKeyAt, valueAt } from '../shared/keyframes';
import { layoutProject, makeMediaClip, newProject, transformAt } from '../shared/timeline';
import { buildExportArgs } from '../shared/export-graph';
import type { MediaItem } from '../shared/types';
import { dropPhantoms, levels } from '../shared/speech';

test('панели: по умолчанию и после «поменять стороны» как в 0.3', () => {
  const L = defaultLayout();
  assert.deepEqual(docksOf(L), { left: ['files'], right: ['inspector', 'assistant'], float: {}, rail: 'left' });
  const swapped = { ...L, swap: true };
  assert.deepEqual(docksOf(swapped).left, ['assistant', 'inspector']);
  assert.deepEqual(docksOf(swapped).right, ['files']);
  const m = { ...L, ...mirror(L) };
  assert.deepEqual(docksOf(m).left, ['assistant', 'inspector']);
  assert.equal(docksOf(m).rail, 'right');
});

test('панели: открепить, пристыковать в другое место и вернуть домой', () => {
  let L = defaultLayout();
  L = { ...L, ...movePane(L, 'inspector', { float: { x: 100, y: 100, w: 340, h: 500 } }) };
  let d = docksOf(L);
  assert.deepEqual(d.right, ['assistant']);
  assert.ok(d.float.inspector);
  // настройки — к левому краю, рядом с медиатекой
  L = { ...L, ...movePane(L, 'inspector', { side: 'left', index: 1 }) };
  d = docksOf(L);
  assert.deepEqual(d.left, ['files', 'inspector']);
  assert.equal(d.float.inspector, undefined);
  // перестановка внутри одной стороны
  L = { ...L, ...movePane(L, 'files', { side: 'left', index: 2 }) };
  assert.deepEqual(docksOf(L).left, ['inspector', 'files']);
  // медиатека уехала направо — кнопки рейки едут вместе с ней
  L = { ...L, ...movePane(L, 'files', { side: 'right', index: 1 }) };
  d = docksOf(L);
  assert.deepEqual(d.right, ['assistant', 'files']);
  assert.equal(d.rail, 'right');
  assert.equal(L.swap, true);
  // вернуть на место: настройки — на сторону без медиатеки, ближе к центру
  L = { ...L, ...movePane(L, 'inspector', homeTarget(L, 'inspector')) };
  assert.deepEqual(docksOf(L).left, ['inspector']);
});

test('панели: каждая ровно в одном месте, даже если настройки испорчены', () => {
  const L = { ...defaultLayout(), dockLeft: ['files', 'files', 'inspector'] as any, dockRight: ['inspector'] as any, float: {} };
  const d = docksOf(L);
  const all = [...d.left, ...d.right, ...Object.keys(d.float)];
  assert.equal(all.length, 3);
  assert.deepEqual([...all].sort(), ['assistant', 'files', 'inspector']);
});

function media(): MediaItem {
  return { id: 'm', path: 'a.png', name: 'a', kind: 'image', duration: 5, width: 100, height: 100, hasAudio: false, fps: 30, size: 1 };
}

test('ключевые кадры: плавно между ключами, до первого и после последнего — стоит', () => {
  const c = makeMediaClip(media(), { out: 4 });
  c.keys = setKeyAt(c, 1, { x: 0.2 });
  c.keys = setKeyAt(c, 3, { x: 0.8 });
  // первый ключ — текущее положение в начале клипа
  assert.equal(c.keys.length, 3);
  assert.equal(valueAt(keysOf(c), 'x', 2), 0.5);
  assert.ok(valueAt(keysOf(c), 'x', 1.5) < 0.35, 'плавный разгон: в первой четверти пути меньше линейного');
  assert.equal(transformAt(c, 3.9).x, 0.8);
  // повторная правка того же момента меняет ключ, а не добавляет новый
  c.keys = setKeyAt(c, 3.01, { scale: 2 });
  assert.equal(c.keys.length, 3);
  assert.equal(c.keys[2].scale, 2);
  c.keys = removeKey(c, 1);
  assert.equal(c.keys.length, 2);
  // старое движение «от начала к концу» становится двумя ключами
  const d = makeMediaClip(media(), { out: 2, animate: true });
  d.transformEnd = { ...d.transform, scale: 1.5 };
  assert.deepEqual(keysOf(d).map(k => [k.t, k.scale]), [[0, 1], [2, 1.5]]);
  assert.equal(transformAt(d, 1).scale, 1.25);
});

const ff = process.env.FFMPEG || 'ffmpeg';
const hasFF = spawnSync(ff, ['-version']).status === 0;

test('ключевые кадры в экспорте: положение и прозрачность совпадают с просмотром', { skip: !hasFF }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kadr-v04-'));
  const bg = join(dir, 'bg.png'), sq = join(dir, 'sq.png'), out = join(dir, 'out.mp4');
  spawnSync(ff, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180', '-frames:v', '1', bg]);
  spawnSync(ff, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=100x100', '-frames:v', '1', sq]);
  const p = newProject('k', 320, 180, 30);
  const mb: MediaItem = { ...media(), id: 'b', path: bg, width: 320, height: 180 };
  const ms: MediaItem = { ...media(), id: 's', path: sq };
  p.media.push(mb, ms);
  p.tracks[0].clips.push(makeMediaClip(mb, { out: 3 }));
  const o = makeMediaClip(ms, { out: 3 });
  // 100×100 вписывается в 180 по высоте, ×0.2 = 36 px
  o.keys = [
    { t: 0, x: 0.2, y: 0.5, scale: 0.2, rotation: 0, opacity: 1, ease: 'linear' },
    { t: 2, x: 0.8, y: 0.5, scale: 0.2, rotation: 0, opacity: 1, ease: 'linear' },
    { t: 3, x: 0.8, y: 0.5, scale: 0.2, rotation: 0, opacity: 0 },
  ];
  p.tracks[1].clips.push(o);
  layoutProject(p);
  const plan = buildExportArgs(p, [], { outPath: out, format: 'mp4', width: 320, height: 180, fps: 30, quality: 'best', encoder: 'cpu' });
  const r = spawnSync(ff, plan.args, { maxBuffer: 1 << 26 });
  assert.equal(r.status, 0, r.stderr.toString().slice(-2000));
  const frame = (t: number) => {
    const g = spawnSync(ff, ['-loglevel', 'error', '-ss', String(t), '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
    return g.stdout as Buffer;
  };
  // в 1 с квадрат ровно посередине пути: x = 0.5
  const f1 = frame(1);
  let sx = 0, n = 0;
  for (let y = 0; y < 180; y++) for (let x = 0; x < 320; x++) if (f1[y * 320 + x] > 128) { sx += x; n++; }
  assert.ok(n > 800, `квадрат виден (${n} px)`);
  assert.ok(Math.abs(sx / n - 160) < 4, `центр по x ${sx / n}`);
  // в 2.5 с прозрачность около половины
  const f2 = frame(2.5);
  const v = f2[90 * 320 + 256];
  assert.ok(v > 90 && v < 165, `яркость ${v}`);
});

test('распознавание: текст в тишине и «Продолжение следует» отбрасываются, настоящая речь остаётся', () => {
  const sr = 8000;
  const x = new Float32Array(sr * 12);
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  for (let i = 0; i < x.length; i++) {
    const t = i / sr;
    // голос 0–4 с и 10–12 с (слоги по 0.25 с), между ними почти тишина
    const speaking = t < 4 || t >= 10;
    const syllable = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t);
    x[i] = speaking ? 0.3 * syllable * Math.sin(2 * Math.PI * 180 * t) + rnd() * 0.02 : rnd() * 0.0005;
  }
  const db = levels(x, sr, 20);
  const segs = [
    { start: 0.2, end: 3.8, text: 'Привет, сегодня покажу монтаж.' },
    { start: 4.5, end: 8.5, text: 'Продолжение следует...' },
    { start: 5, end: 9.5, text: 'Какой-то текст из ниоткуда' },
    { start: 10, end: 11.9, text: 'Спасибо за просмотр!' },
  ];
  const kept = dropPhantoms(segs, db, 20).map(s => s.text);
  assert.deepEqual(kept, ['Привет, сегодня покажу монтаж.', 'Спасибо за просмотр!']);
  // оценки сервиса: «тут тишина» и зацикливание
  const svc = dropPhantoms([
    { start: 0, end: 2, text: 'нормально', noSpeech: 0.1, logprob: -0.3 },
    { start: 2, end: 3, text: 'выдумка', noSpeech: 0.9, logprob: -1.4 },
    { start: 3, end: 4, text: 'ля ля ля ля ля ля ля ля', compression: 3.1 },
  ]);
  assert.deepEqual(svc.map(s => s.text), ['нормально']);
  // один и тот же длинный кусок подряд много раз — остаётся два
  const rep = dropPhantoms(Array.from({ length: 5 }, (_, i) => ({ start: i, end: i + 1, text: 'и снова то же самое' })));
  assert.equal(rep.length, 2);
});
