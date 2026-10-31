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

test('надёжная запись: файл подменяется целиком, испорченный читается из копии', async () => {
  const { writeFileAtomic, readJsonSafe } = await import('../electron/safe-write');
  const { mkdtempSync, readFileSync, readdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'hl-safe-'));
  const f = join(dir, 'папка', 'настройки.json');
  writeFileAtomic(f, JSON.stringify({ v: 1 }), { backup: true });
  assert.deepEqual(readJsonSafe(f), { v: 1 });
  writeFileAtomic(f, JSON.stringify({ v: 2 }), { backup: true });
  assert.deepEqual(JSON.parse(readFileSync(f + '.bak', 'utf8')), { v: 1 });
  // временных файлов не остаётся
  assert.deepEqual(readdirSync(join(dir, 'папка')).sort(), ['настройки.json', 'настройки.json.bak']);
  // основной файл обрезан (сбой при старой записи) — берётся предыдущая версия
  writeFileSync(f, '{"v": 3, "обрез');
  assert.deepEqual(readJsonSafe(f), { v: 1 });
  assert.equal(readJsonSafe(join(dir, 'нет.json')), null);
  // двоичные данные
  writeFileAtomic(join(dir, 'b.bin'), new Uint8Array([1, 2, 3]));
  assert.deepEqual([...readFileSync(join(dir, 'b.bin'))], [1, 2, 3]);
});

// ── Сохранение по частям ──
import { inputLoad, narrowToRange, partFrames, planParts, sliceProject } from '../shared/export-parts';
import { clipEnd, layoutProject, makeMediaClip, makeTextClip, newProject, projectDuration } from '../shared/timeline';
import type { MediaItem as MI, Project as Proj, TextClip as TC } from '../shared/types';
import { spawnSync as spawnSync10 } from 'node:child_process';

const ff10 = process.env.FFMPEG || 'ffmpeg';
const hasFF10 = spawnSync10(ff10, ['-version']).status === 0;

const vid10 = (id: string, path = `/v/${id}.mp4`, dur = 600): MI => ({ id, path, name: id, kind: 'video', duration: dur, width: 640, height: 360, hasAudio: true, fps: 30, size: 1 });
const aud10 = (id: string, path = `/a/${id}.mp3`, dur = 600): MI => ({ id, path, name: id, kind: 'audio', duration: dur, width: 0, height: 0, hasAudio: true, fps: 0, size: 1 });

/** Ролик «после убрать паузы»: count кусков по len секунд из одного файла, музыка на весь ролик, подписи */
function choppy(count: number, len = 2): Proj {
  const p = newProject('Тест', 640, 360, 30);
  const v = vid10('v'), a = aud10('a');
  p.media.push(v, a);
  for (let i = 0; i < count; i++) p.tracks[0].clips.push(makeMediaClip(v, { in: i * (len + 0.5), out: i * (len + 0.5) + len }));
  layoutProject(p);
  p.tracks[3].clips.push(makeMediaClip(a, { start: 0, out: count * len, volume: 0.5, audioFadeIn: 1 }));
  return p;
}

test('части: короткий ролик сохраняется одним проходом', () => {
  assert.deepEqual(planParts(choppy(10), []), []);
  assert.equal(inputLoad(choppy(10), []), 11);
});

test('части: 200 кусков делятся по склейкам, части без дыр и не тяжелее предела', () => {
  const p = choppy(200);
  const parts = planParts(p, [], 24);
  assert.ok(parts.length >= 9, String(parts.length));
  assert.equal(parts[0].start, 0);
  assert.equal(parts[parts.length - 1].end, projectDuration(p));
  for (let i = 0; i < parts.length; i++) {
    if (i) { assert.equal(parts[i].start, parts[i - 1].end); assert.equal(parts[i].first, parts[i - 1].last + 1); }
    assert.ok(parts[i].last - parts[i].first + 1 <= 23, 'часть слишком большая'); // + музыка
    assert.equal(parts[i].start, p.tracks[0].clips[parts[i].first].start);
  }
});

test('части: музыка через границу обрезается по началу части, подпись тоже, время с нуля', () => {
  const p = choppy(60);
  const t = makeTextClip('Подпись', 15, 20) as TC; // лежит через границу
  p.tracks[2].clips.push(t);
  const renders = [{ clipId: t.id, path: 'a.png', from: 0, to: 4 }, { clipId: t.id, path: 'b.png', from: 4, to: 20 }];
  const parts = planParts(p, renders, 12);
  const k = parts.findIndex(x => x.start > 15 && x.start < 35);
  assert.ok(k > 0, 'граница внутри подписи');
  const part = parts[k];
  const { project: s, texts } = sliceProject(p, renders, part);
  const music = s.tracks[3].clips[0] as any;
  assert.equal(music.start, 0);
  assert.ok(Math.abs(music.in - part.start) < 1e-6, 'музыка продолжается с того же места');
  assert.equal(music.audioFadeIn, 0);
  assert.equal(s.tracks[0].clips.length, part.last - part.first + 1);
  assert.equal(s.tracks[0].clips[0].start, 0);
  const st = s.tracks[2].clips.find(c => c.id === t.id) as TC;
  const delta = part.start - 15;
  assert.equal(st.start, 0);
  assert.ok(Math.abs(st.duration - (20 - delta)) < 1e-6);
  const shifted = texts.filter(r => r.clipId === t.id);
  assert.ok(shifted.every(r => (r.from ?? 0) >= 0 && (r.to ?? 0) > 0));
  assert.ok(Math.abs((shifted[shifted.length - 1].to ?? 0) - (20 - delta)) < 1e-6);
  // исходный проект не тронут
  assert.equal((p.tracks[3].clips[0] as any).in, 0);
});

test('части: не режем через переход и через слой с ключевыми кадрами', () => {
  const p = choppy(80);
  const main = p.tracks[0].clips as any[];
  for (let i = 1; i < main.length; i += 2) main[i].transition = { type: 'fade', duration: 0.5 };
  layoutProject(p);
  const over = makeMediaClip(vid10('v'), { start: 30, out: 40 }) as any;
  over.keys = [{ t: 0, x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1 }, { t: 5, x: 0.6, y: 0.5, scale: 1, rotation: 0, opacity: 1 }];
  p.tracks[1].clips.push(over);
  const parts = planParts(p, [], 12);
  assert.ok(parts.length > 1);
  for (const part of parts.slice(1)) {
    assert.ok(!main[part.first].transition, 'граница на переходе');
    assert.ok(!(part.start > over.start && part.start < clipEnd(over)), 'граница внутри анимированного слоя');
  }
});

test('части: точные кадры для отрезка и один кадр из нужной части', () => {
  const p = choppy(100);
  const parts = planParts(p, [], 24);
  const total = projectDuration(p);
  const all = partFrames(parts, 30, 0, total);
  assert.equal(all.reduce((a, x) => a + x.frames, 0), Math.round(total * 30));
  const some = partFrames(parts, 30, 7.3, 120.1);
  assert.equal(some.reduce((a, x) => a + x.frames, 0), Math.round((120.1 - 7.3) * 30));
  const near = narrowToRange(p, [], 150, 150.04, 24)!;
  assert.ok(near && near.offset <= 150 && near.project.tracks[0].clips.length <= 23);
});

test('части: настоящий FFmpeg — части склеиваются в ролик точной длины, звук не съезжает', { skip: !hasFF10 }, async () => {
  const { exportInParts } = await import('../electron/export-parts-run');
  const { spawn } = await import('node:child_process');
  const { mkdtempSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'hl-parts-'));
  const src = join(dir, 'src.mp4'), music = join(dir, 'm.mp3');
  const g = spawnSync10(ff10, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=40', '-f', 'lavfi', '-i', 'sine=f=440:d=40', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]);
  assert.equal(g.status, 0, g.stderr?.toString());
  assert.equal(spawnSync10(ff10, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=220:d=60', music]).status, 0);
  const p = newProject('Части', 320, 180, 30);
  const v = { ...vid10('v', src, 40) }, a = aud10('a', music, 60);
  p.media.push(v, a);
  for (let i = 0; i < 30; i++) p.tracks[0].clips.push(makeMediaClip(v, { in: i * 1.3, out: i * 1.3 + 1.1 }));
  layoutProject(p);
  p.tracks[3].clips.push(makeMediaClip(a, { start: 0, out: 33, volume: 0.4 }));
  const t = makeTextClip('Подпись', 2, 20);
  p.tracks[2].clips.push(t);
  const total = projectDuration(p);
  const parts = planParts(p, [], 6);
  assert.ok(parts.length >= 5, String(parts.length));
  const run = (bin: string, args: string[], o: { onStdout?: (s: string) => void; signal?: AbortSignal }) => new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    const ch = spawn(bin, args);
    let stdout = '', stderr = '';
    ch.stdout.on('data', d => { stdout += d; o.onStdout?.(String(d)); });
    ch.stderr.on('data', d => { stderr = (stderr + d).slice(-20000); });
    ch.on('close', code => resolve({ code: code ?? -1, stdout, stderr }));
  });
  const probe = (f: string, what: string) => spawnSync10(ff10.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1'), ['-v', 'error', ...what.split(' '), '-of', 'csv=p=0', f]).stdout.toString().trim();
  for (const format of ['mp4', 'wav'] as const) {
    const out = join(dir, 'out.' + format);
    let last = 0;
    const res = await exportInParts({ ffmpeg: ff10, run, workDir: dir }, p, [], { outPath: out, format, width: 320, height: 180, fps: 30, quality: 'draft', encoder: 'cpu', loudness: -14 }, parts, undefined, new AbortController().signal, pr => { assert.ok(pr >= last - 1e-9); last = pr; });
    assert.equal(res.r.code, 0, res.r.stderr.slice(-1500));
    assert.ok(existsSync(out));
    const expected = Math.round(total * 30);
    if (format === 'mp4') {
      const frames = Number(probe(out, '-select_streams v:0 -count_packets -show_entries stream=nb_read_packets'));
      assert.equal(frames, expected, 'кадров должно быть ровно столько, сколько в ролике');
      const ad = Number(probe(out, '-select_streams a:0 -show_entries stream=duration'));
      assert.ok(Math.abs(ad - expected / 30) < 0.05, `звук ${ad} против ${expected / 30}`);
    } else {
      const ad = Number(probe(out, '-show_entries format=duration'));
      assert.ok(Math.abs(ad - expected / 30) < 0.01, `звук ${ad} против ${expected / 30}`);
    }
  }
});
