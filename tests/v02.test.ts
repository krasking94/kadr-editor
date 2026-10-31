// Проверки возможностей версии 0.2 через настоящий FFmpeg: хромакей, LUT, путь слоя,
// обработка голоса, выравнивание громкости и субтитры «слово за словом» одной лентой картинок.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildExportArgs, pathExpr } from '../shared/export-graph';
import { makeMediaClip, makeTextClip, newProject, projectDuration, layoutProject } from '../shared/timeline';
import { parseSrt, toSrt } from '../shared/srt';
import { chunkWords, findFillers, simplifyPath } from '../shared/speech';
import type { MediaItem, TextRender } from '../shared/types';

const ff = process.env.FFMPEG || 'ffmpeg';
const hasFF = spawnSync(ff, ['-version']).status === 0;
const dir = mkdtempSync(join(tmpdir(), 'kadr-v02-'));

function gen(name: string, args: string[]) {
  const out = join(dir, name);
  const r = spawnSync(ff, ['-hide_banner', '-loglevel', 'error', '-y', ...args, out]);
  assert.equal(r.status, 0, r.stderr?.toString());
  return out;
}

function probe(file: string, entries: string): string {
  const r = spawnSync(ff.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1'), ['-v', 'error', '-show_entries', entries, '-of', 'csv=p=0', file]);
  return r.stdout.toString().trim();
}

function run(plan: ReturnType<typeof buildExportArgs>) {
  for (const f of plan.files) writeFileSync(f.path, f.content);
  const r = spawnSync(ff, plan.args, { maxBuffer: 1 << 26 });
  assert.equal(r.status, 0, r.stderr.toString().slice(-3000));
}

// Цвет пикселя в точке готового видео (через ffmpeg → rgb24)
function pixel(file: string, t: number, x: number, y: number): number[] {
  const r = spawnSync(ff, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `format=rgb24,crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return [...r.stdout.subarray(0, 3)];
}

test('выражение пути: значения в точках и между ними', () => {
  const e = pathExpr([{ t: 0, v: 0.2 }, { t: 2, v: 0.6 }, { t: 4, v: 0.6 }], 'T');
  const fn = new Function('T', 'iff', 'lt', 'gte', 'return ' + e.replace(/\bif\(/g, 'iff('));
  const val = (T: number) => fn(T, (c: number, a: number, b: number) => (c ? a : b), (a: number, b: number) => (a < b ? 1 : 0), (a: number, b: number) => (a >= b ? 1 : 0));
  assert.ok(Math.abs(val(0) - 0.2) < 1e-6);
  assert.ok(Math.abs(val(1) - 0.4) < 1e-6);
  assert.ok(Math.abs(val(3) - 0.6) < 1e-6);
  assert.ok(Math.abs(val(9) - 0.6) < 1e-6);
});

test('SRT: чтение и запись туда и обратно', () => {
  const src = '1\r\n00:00:01,000 --> 00:00:02,500\r\nПривет, мир\r\n\r\n2\r\n00:00:03,250 --> 00:00:05,000\r\nВторая\r\nстрока\r\n';
  const items = parseSrt(src);
  assert.equal(items.length, 2);
  assert.equal(items[0].start, 1);
  assert.equal(items[0].end, 2.5);
  assert.equal(items[1].text, 'Вторая\nстрока');
  const back = parseSrt(toSrt(items));
  assert.deepEqual(back, items);
  const vtt = parseSrt('WEBVTT\n\n00:01.000 --> 00:02.000\nКоротко\n');
  assert.equal(vtt[0].start, 1);
});

test('субтитры «слово за словом»: деление на короткие фразы', () => {
  const words = 'раз два три четыре пять шесть семь'.split(' ').map((w, i) => ({ s: i * 0.5, e: i * 0.5 + 0.4, w }));
  const chunks = chunkWords(words, 3);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].words.length, 3);
  assert.equal(chunks[0].words[0].s, 0);
  assert.equal(chunks[1].start, 1.5);
  assert.equal(chunks[1].words[0].s, 0); // время слов — от начала фразы
});

test('слова-паразиты находятся, обычные слова — нет', () => {
  const words = ['Эээ,', 'сегодня', 'ну', 'короче', 'мы', 'ммм', 'сделаем', 'Ну?'].map((w, i) => ({ s: i, e: i + 0.5, w }));
  const found = findFillers(words, ['ээ', 'мм', 'короче']);
  assert.deepEqual(found.map(f => f.w), ['Эээ,', 'короче', 'ммм']);
});

test('упрощение пути камеры оставляет мало точек', () => {
  const pts = Array.from({ length: 200 }, (_, i) => ({ t: i * 0.1, x: 0.5 + (i > 100 ? 0.1 : 0), y: 0.5 }));
  const s = simplifyPath(pts, 0.005);
  assert.ok(s.length <= 6, 'точек: ' + s.length);
});

test('хромакей, LUT, путь слоя, голос и громкость собираются и работают', { skip: !hasFF }, () => {
  // зелёный фон с красным квадратом — после хромакея зелёное должно стать прозрачным
  const green = gen('green.mp4', ['-f', 'lavfi', '-i', 'color=c=0x00ff00:s=320x240:r=30:d=2,drawbox=x=120:y=80:w=80:h=80:c=red:t=fill', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
  const bgVideo = gen('blue.mp4', ['-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=30:d=2', '-f', 'lavfi', '-i', 'sine=f=300:d=2', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
  // LUT в папке с двоеточием и апострофом в имени — проверка экранирования пути
  // в Windows двоеточие в имени папки запрещено, там его проверяет буква диска (C:)
  const lutDir = join(dir, process.platform === 'win32' ? "Max's LUT" : "Max's: LUT");
  mkdirSync(lutDir, { recursive: true });
  const lut = join(lutDir, 'invert.cube');
  const rows: string[] = ['LUT_3D_SIZE 2'];
  for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) rows.push(`${1 - r} ${1 - g} ${1 - b}`);
  writeFileSync(lut, rows.join('\n') + '\n');

  const p = newProject('Тест', 640, 360, 30);
  const mg: MediaItem = { id: 'g', path: green, name: 'g', kind: 'video', duration: 2, width: 320, height: 240, hasAudio: false, fps: 30, size: 1 };
  const mb: MediaItem = { id: 'b', path: bgVideo, name: 'b', kind: 'video', duration: 2, width: 640, height: 360, hasAudio: true, fps: 30, size: 1 };
  p.media.push(mg, mb);
  const base = makeMediaClip(mb, { voice: true, denoise: 0.5 });
  base.color.lut = lut; // синий → жёлтый
  p.tracks[0].clips.push(base);
  const keyed = makeMediaClip(mg, { start: 0, out: 2, key: { color: '#00ff00', similarity: 0.3, blend: 0.05 } });
  keyed.color.saturation = 1.2;
  keyed.path = [{ t: 0, x: 0.5, y: 0.5 }, { t: 2, x: 0.5, y: 0.5 }];
  p.tracks[1].clips.push(keyed);
  layoutProject(p);
  const out = join(dir, 'fx.mp4');
  const plan = buildExportArgs(p, [], { outPath: out, format: 'mp4', width: 640, height: 360, fps: 30, quality: 'draft', encoder: 'cpu', loudness: -14 });
  run(plan);
  assert.ok(Math.abs(Number(probe(out, 'format=duration')) - projectDuration(p)) < 0.25);
  const corner = pixel(out, 1, 20, 20); // фон: синий через инвертирующий LUT → жёлтый
  assert.ok(corner[0] > 180 && corner[1] > 180 && corner[2] < 90, 'угол: ' + corner);
  const center = pixel(out, 1, 320, 180); // красный квадрат слоя остался
  assert.ok(center[0] > 150 && center[1] < 90, 'центр: ' + center);
});

test('субтитры «слово за словом» идут одной лентой картинок', { skip: !hasFF }, () => {
  const p = newProject('Тест', 640, 360, 30);
  const texts: TextRender[] = [];
  const red = gen('w_red.png', ['-f', 'lavfi', '-i', 'color=c=red:s=640x360,format=rgba', '-frames:v', '1']);
  const white = gen('w_white.png', ['-f', 'lavfi', '-i', 'color=c=white:s=640x360,format=rgba', '-frames:v', '1']);
  const blank = gen('blank.png', ['-f', 'lavfi', '-i', 'color=c=black@0:s=640x360,format=rgba', '-frames:v', '1']);
  const a = makeTextClip('раз два', 1, 1, {}); a.animIn = 'none'; a.animOut = 'none'; a.subtitle = true;
  a.words = [{ s: 0, e: 0.5, w: 'раз' }, { s: 0.5, e: 1, w: 'два' }];
  const b = makeTextClip('три', 3, 1, {}); b.animIn = 'none'; b.animOut = 'none'; b.subtitle = true;
  p.tracks[2].clips.push(a, b);
  texts.push({ clipId: a.id, path: red, from: 0, to: 0.5 }, { clipId: a.id, path: white, from: 0.5, to: 1 }, { clipId: b.id, path: red });
  layoutProject(p);
  const out = join(dir, 'karaoke.mp4');
  const plan = buildExportArgs(p, texts, { outPath: out, format: 'mp4', width: 640, height: 360, fps: 30, quality: 'draft', encoder: 'cpu' }, { tempDir: dir, blank });
  assert.equal(plan.files.length, 1, 'одна лента на дорожку');
  assert.equal(plan.args.filter(x => x === '-i').length, 1, 'одна лента субтитров вместо входа на каждое слово');
  run(plan);
  const at = (t: number) => pixel(out, t, 100, 100);
  assert.ok(at(0.5)[0] < 40, 'до субтитров пусто');
  assert.ok(at(1.25)[0] > 200 && at(1.25)[1] < 60, 'первое слово красное');
  assert.ok(at(1.75)[1] > 200, 'второе слово белое');
  assert.ok(at(2.5)[0] < 40, 'между строками пусто');
  assert.ok(at(3.5)[0] > 200, 'вторая строка');
});
