// Проверки версии 0.7: режимы наложения, корректирующий слой, обрезка и форма, цветовые круги, размытие лиц, звук.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { layoutProject, makeMediaClip, newProject } from '../shared/timeline';
import { buildExportArgs } from '../shared/export-graph';
import { applyWheels, croppedMedia, effectiveCrop, eqFilters, facesAt, wheelsFilter } from '../shared/look';
import type { MediaItem, Project, TextRender } from '../shared/types';

const ff = process.env.FFMPEG || 'ffmpeg';
const hasFF = spawnSync(ff, ['-version']).status === 0;

const img = (id: string, path: string, w = 320, h = 180): MediaItem => ({ id, path, name: id, kind: 'image', duration: 5, width: w, height: h, hasAudio: false, fps: 30, size: 1 });

function render(p: Project, out: string, texts: TextRender[] = [], tempDir?: string) {
  layoutProject(p);
  const plan = buildExportArgs(p, texts, { outPath: out, format: 'mp4', width: p.width, height: p.height, fps: 30, quality: 'best', encoder: 'cpu' }, tempDir ? { tempDir, blank: join(tempDir, 'blank.png') } : {});
  for (const f of plan.files) writeFileSync(f.path, f.content);
  const r = spawnSync(ff, plan.args, { maxBuffer: 1 << 26 });
  assert.equal(r.status, 0, r.stderr.toString().slice(-2500));
  return plan;
}

function grab(out: string, t: number, w = 320) {
  const g = spawnSync(ff, ['-loglevel', 'error', '-ss', String(t), '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']).stdout as Buffer;
  return (x: number, y: number) => [...g.subarray((y * w + x) * 3, (y * w + x) * 3 + 3)];
}

const solid = (dir: string, name: string, color: string, size = '320x180') => {
  const f = join(dir, name);
  spawnSync(ff, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}`, '-frames:v', '1', f]);
  return f;
};

test('обрезка: круг сам становится квадратом по центру, размер слоя считается после обрезки', () => {
  const m = { width: 1920, height: 1080 };
  const cr = effectiveCrop({ mask: 'circle' }, m);
  assert.ok(Math.abs(cr.l - 420 / 1920) < 1e-6 && Math.abs(cr.r - cr.l) < 1e-9 && cr.t === 0);
  const cm = croppedMedia(m, { crop: { l: 0.25, r: 0.25, t: 0, b: 0.5 } });
  assert.deepEqual([cm.width, cm.height], [960, 540]);
  // лишнее срезать нельзя больше чем почти всё
  const big = effectiveCrop({ crop: { l: 0.8, r: 0.8, t: 0, b: 0 } }, m);
  assert.ok(big.l + big.r <= 0.95 + 1e-9);
});

test('цветовые круги: формула просмотра совпадает с FFmpeg colorbalance', { skip: !hasFF }, () => {
  const wheels = { shadows: { hue: 0, amount: 0.8 }, midtones: { hue: 200, amount: 0.5 }, highlights: { hue: 60, amount: 0.6 } };
  const ramp = Buffer.alloc(256 * 3);
  for (let i = 0; i < 256; i++) { ramp[i * 3] = i; ramp[i * 3 + 1] = (i * 7) % 256; ramp[i * 3 + 2] = 255 - i; }
  const r = spawnSync(ff, ['-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '256x1', '-i', '-', '-vf', wheelsFilter(wheels), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { input: ramp });
  assert.equal(r.status, 0, r.stderr.toString());
  const px = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) { px[i * 4] = ramp[i * 3]; px[i * 4 + 1] = ramp[i * 3 + 1]; px[i * 4 + 2] = ramp[i * 3 + 2]; px[i * 4 + 3] = 255; }
  applyWheels(px, wheels);
  let worst = 0;
  for (let i = 0; i < 256; i++) for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(px[i * 4 + c] - r.stdout[i * 3 + c]));
  assert.ok(worst <= 3, `расхождение ${worst}`);
});

test('режим «Экран»: чёрное у слоя исчезает, светлое осветляет картинку под ним', { skip: !hasFF }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kadr-v07b-'));
  const bg = solid(dir, 'bg.png', '0x204080');
  const fg = join(dir, 'fg.png');
  // слева чёрная половина, справа серая
  spawnSync(ff, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', "color=c=black:s=320x180,format=rgb24,geq=r='if(gt(X,160),128,0)':g='if(gt(X,160),128,0)':b='if(gt(X,160),128,0)'", '-frames:v', '1', fg]);
  const p = newProject('b', 320, 180, 30);
  const mb = img('b', bg), mf = img('f', fg);
  p.media.push(mb, mf);
  p.tracks[0].clips.push(makeMediaClip(mb, { out: 2 }));
  p.tracks[1].clips.push(makeMediaClip(mf, { out: 2, blend: 'screen' }));
  const out = join(dir, 'out.mp4');
  render(p, out);
  const px = grab(out, 1);
  const left = px(60, 90), right = px(260, 90);
  assert.ok(Math.abs(left[2] - 0x80) < 12 && Math.abs(left[0] - 0x20) < 12, `слева фон без изменений: ${left}`);
  // screen(0x20, 0x80) ≈ 0x90, screen(0x80, 0x80) ≈ 0xC0
  assert.ok(right[0] > 0x80 && right[2] > 0xb0, `справа светлее: ${right}`);
});

test('корректирующий слой красит всё под собой только в своё время', { skip: !hasFF }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kadr-v07a-'));
  const bg = solid(dir, 'bg.png', 'red');
  const blank = solid(dir, 'adj.png', 'black@0');
  const p = newProject('a', 320, 180, 30);
  const mb = img('b', bg), ma = img('a', blank);
  p.media.push(mb, ma);
  p.tracks[0].clips.push(makeMediaClip(mb, { out: 3 }));
  const adj = makeMediaClip(ma, { out: 1, start: 1, adjust: true });
  adj.color.saturation = 0; // чёрно-белое
  p.tracks[1].clips.push(adj);
  const out = join(dir, 'out.mp4');
  render(p, out);
  const before = grab(out, 0.5)(160, 90), during = grab(out, 1.5)(160, 90), after = grab(out, 2.5)(160, 90);
  assert.ok(before[0] > 200 && before[1] < 60, `до слоя красный: ${before}`);
  assert.ok(Math.abs(during[0] - during[1]) < 15, `под слоем серый: ${during}`);
  assert.ok(after[0] > 200 && after[1] < 60, `после слоя снова красный: ${after}`);
});

test('круглая маска: углы слоя прозрачные, середина видна', { skip: !hasFF }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kadr-v07m-'));
  const bg = solid(dir, 'bg.png', 'blue');
  const fg = solid(dir, 'fg.png', 'white', '320x180');
  const p = newProject('m', 320, 180, 30);
  const mb = img('b', bg), mf = img('f', fg);
  p.media.push(mb, mf);
  p.tracks[0].clips.push(makeMediaClip(mb, { out: 2 }));
  // круг диаметром во весь кадр по высоте: 180×180 по центру
  p.tracks[1].clips.push(makeMediaClip(mf, { out: 2, mask: 'circle' }));
  const out = join(dir, 'out.mp4');
  render(p, out);
  const px = grab(out, 1);
  assert.ok(px(160, 90).every(v => v > 200), `центр белый: ${px(160, 90)}`);
  const corner = px(160 - 85, 90 - 85);
  assert.ok(corner[2] > 180 && corner[0] < 80, `угол квадрата за кругом синий: ${corner}`);
  const outside = px(30, 90);
  assert.ok(outside[2] > 180 && outside[0] < 80, `срезанная часть кадра не видна: ${outside}`);
});

test('размытие лиц: размыто только внутри маски', { skip: !hasFF }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kadr-v07f-'));
  const v = join(dir, 'v.mp4');
  // шахматка из мелких клеток: размытая она становится серой
  const r0 = spawnSync(ff, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', "nullsrc=s=320x180:d=2:r=30,geq=lum='255*mod(floor(X/4)+floor(Y/4),2)':cb=128:cr=128", '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-qp', '0', v]);
  assert.equal(r0.status, 0, r0.stderr.toString());
  const mask = join(dir, 'mask.png');
  spawnSync(ff, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', "color=c=black:s=160x90,format=gray,geq=lum='if(lt(X,80),255,0)'", '-frames:v', '1', mask]);
  solid(dir, 'blank.png', 'black@0');
  const p = newProject('f', 320, 180, 30);
  const mv: MediaItem = { id: 'v', path: v, name: 'v', kind: 'video', duration: 2, width: 320, height: 180, hasAudio: false, fps: 30, size: 1 };
  p.media.push(mv);
  const c = makeMediaClip(mv, { out: 2, faces: { strength: 0.6, step: 1, samples: [{ t: 0, boxes: [[0, 0, 0.5, 1]] }] } });
  p.tracks[0].clips.push(c);
  const out = join(dir, 'out.mp4');
  render(p, out, [{ clipId: 'faces:' + c.id, path: mask, from: 0, to: 2 }], dir);
  const px = grab(out, 1);
  // слева (под маской) клетки смазаны в серое, справа остаются контрастными
  const spread = (x0: number) => { let lo = 255, hi = 0; for (let x = x0; x < x0 + 16; x++) { const g = px(x, 90)[0]; lo = Math.min(lo, g); hi = Math.max(hi, g); } return hi - lo; };
  assert.ok(spread(40) < 60, `слева размыто: ${spread(40)}`);
  assert.ok(spread(240) > 150, `справа чётко: ${spread(240)}`);
  assert.deepEqual(facesAt(c.faces, 0.4), [[0, 0, 0.5, 1]]);
  assert.deepEqual(facesAt(c.faces, 3), []);
});

test('эквалайзер, компрессор и громкость дорожки попадают в звук', { skip: !hasFF }, () => {
  assert.deepEqual(eqFilters({ low: 0, mid: 0, high: 0, comp: 0 }), []);
  const f = eqFilters({ low: 4, mid: -2, high: 3, comp: 0.5 });
  assert.equal(f.length, 4);
  const dir = mkdtempSync(join(tmpdir(), 'kadr-v07e-'));
  const a = join(dir, 'a.wav');
  spawnSync(ff, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=2', a]);
  const p = newProject('e', 320, 180, 30);
  const ma: MediaItem = { id: 'a', path: a, name: 'a', kind: 'audio', duration: 2, width: 0, height: 0, hasAudio: true, fps: 0, size: 1 };
  p.media.push(ma);
  p.tracks[3].clips.push(makeMediaClip(ma, { out: 2, eq: { low: 3, mid: 2, high: 0, comp: 0.4 } }));
  p.tracks[3].volume = 0.5;
  const out = join(dir, 'out.mp4');
  const plan = render(p, out);
  const g = plan.args[plan.args.indexOf('-filter_complex') + 1];
  assert.match(g, /bass=g=3/);
  assert.match(g, /acompressor/);
  assert.match(g, /volume=0\.5/);
});
