// Проверки версии 0.9: скорость по кривой, мультикамера, слежение за объектом, вложенные клипы,
// проверка перед публикацией и черновик ролика.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clipEnd, layoutProject, mainTrack, makeMediaClip, makeTextClip, newProject } from '../shared/timeline';
import { normRamp, rampDuration, rampFilterGraph, rampSegments, RAMP_PRESETS, speedAt } from '../shared/ramp';
import { camAudioSource, commonRange, envelope, findOffset, switchedRange } from '../shared/multicam';
import { matchTemplate, resolveFollows, textShift, trackAt, trackToBlur, type Gray } from '../shared/track';
import { applyGroup, groupProject, planGroup, ungroup } from '../shared/group';
import { analysisIssues, parseAnalysis, sortIssues, staticChecks } from '../shared/preflight';
import { fallbackDraft, parseDraft, snapToWords } from '../shared/draft';
import { buildExportArgs, pathExpr, simplifyPath } from '../shared/export-graph';
import { writeFileSync } from 'node:fs';
import type { MediaClip, MediaItem, TextClip } from '../shared/types';

const ff = process.env.FFMPEG || 'ffmpeg';
const hasFF = spawnSync(ff, ['-version']).status === 0;
const vid = (id: string, dur = 10, audio = true): MediaItem => ({ id, path: `/v/${id}.mp4`, name: id, kind: 'video', duration: dur, width: 1920, height: 1080, hasAudio: audio, fps: 30, size: 1 });
const aud = (id: string, dur = 30): MediaItem => ({ id, path: `/a/${id}.mp3`, name: id, kind: 'audio', duration: dur, width: 0, height: 0, hasAudio: true, fps: 0, size: 1 });

// ── скорость по кривой ──
test('кривая скорости: нормализация, плавность и длина', () => {
  const pts = normRamp([{ u: 0.5, s: 20 }]);
  assert.equal(pts[0].u, 0);
  assert.equal(pts[pts.length - 1].u, 1);
  assert.ok(pts.every(p => p.s <= 8));
  const moment = RAMP_PRESETS.find(r => r.id === 'moment')!.points;
  assert.equal(speedAt(moment, 0), 1);
  assert.ok(Math.abs(speedAt(moment, 0.55) - 0.25) < 1e-6);
  const mid = speedAt(moment, 0.41);
  assert.ok(mid < 1 && mid > 0.25, 'между точками скорость меняется плавно');
  // постоянная ×2 — клип вдвое короче
  assert.ok(Math.abs(rampDuration([{ u: 0, s: 2 }, { u: 1, s: 2 }], 10) - 5) < 0.05);
  // замедление в середине — клип длиннее
  assert.ok(rampDuration(moment, 10) > 12);
  const segs = rampSegments(moment, 10);
  assert.ok(segs.length > 3 && segs.length <= 90);
  assert.ok(Math.abs(segs[0].a) < 1e-9 && Math.abs(segs[segs.length - 1].b - 10) < 1e-6);
});

test('кривая скорости: FFmpeg делает видео и звук одной длины', { skip: !hasFF }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ramp-'));
  const src = join(dir, 'src.mp4'), out = join(dir, 'out.mp4');
  assert.equal(spawnSync(ff, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]).status, 0);
  const pts = RAMP_PRESETS.find(r => r.id === 'moment')!.points;
  const g = rampFilterGraph(pts, 4, 30, true);
  const r = spawnSync(ff, ['-y', '-loglevel', 'error', '-i', src, '-filter_complex', g.graph, ...g.maps.flatMap(m => ['-map', m]), '-c:v', 'libx264', '-c:a', 'aac', out]);
  assert.equal(r.status, 0, r.stderr.toString().slice(-1500));
  const dur = (sel: string) => Number(spawnSync(ff.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1'), ['-v', 'error', '-select_streams', sel, '-show_entries', 'stream=duration', '-of', 'csv=p=0', out]).stdout.toString().trim());
  const want = rampDuration(pts, 4);
  assert.ok(Math.abs(dur('v:0') - want) < 0.15, `видео ${dur('v:0')} ≈ ${want}`);
  assert.ok(Math.abs(dur('a:0') - dur('v:0')) < 0.12, `звук ${dur('a:0')} ≈ видео ${dur('v:0')}`);
});

// ── мультикамера ──
test('мультикамера: сдвиг между камерами находится по звуку', () => {
  const rate = 8000;
  const clap = (sig: Float32Array, at: number) => { const i0 = Math.round(at * rate); for (let i = 0; i < 400; i++) sig[i0 + i] += Math.exp(-i / 60) * (i % 2 ? 1 : -1); };
  const mk = (len: number, claps: number[], noise: number) => {
    const s = new Float32Array(len * rate);
    let seed = noise;
    for (let i = 0; i < s.length; i++) { seed = (seed * 1103515245 + 12345) % 2147483648; s[i] = ((seed / 2147483648) - 0.5) * 0.02; }
    claps.forEach(c => clap(s, c));
    return s;
  };
  const claps = [1.3, 2.9, 4.1, 6.7, 7.2, 9.5, 12.25, 13.8];
  const a = mk(16, claps, 7);
  const b = mk(18, claps.map(c => c + 2.37), 99); // вторая камера включилась на 2,37 с раньше
  const r = findOffset(envelope(a, rate), envelope(b, rate));
  assert.ok(Math.abs(r.offset - 2.37) < 0.03, `сдвиг ${r.offset}`);
  assert.ok(r.confidence > 5, `уверенность ${r.confidence}`);
});

test('мультикамера: переключение берёт тот же момент съёмки и звук главной камеры', () => {
  const p = newProject();
  const m0 = vid('cam0', 20), m1 = vid('cam1', 25);
  p.media.push(m0, m1);
  p.multicam = [{ id: 'g', name: 'Мультикамера', angles: [{ mediaId: 'cam0', offset: 0 }, { mediaId: 'cam1', offset: 3 }], audio: 0 }];
  const c = makeMediaClip(m0, { in: 5, out: 9, cam: { group: 'g', angle: 0 } });
  mainTrack(p).clips.push(c);
  const r = switchedRange(p.multicam[0], c, 1, m1)!;
  assert.deepEqual(r, { in: 8, out: 12 });
  const sw: MediaClip = { ...c, mediaId: 'cam1', in: r.in, out: r.out, cam: { group: 'g', angle: 1 } };
  const au = camAudioSource(p, sw)!;
  assert.equal(au.media.id, 'cam0');
  assert.equal(au.in, 5);
  assert.equal(camAudioSource(p, c), null, 'когда в кадре главная камера, звук свой');
  const range = commonRange(p.multicam[0], [m0, m1]);
  assert.deepEqual(range, { start: 0, end: 20 });
});

test('мультикамера: при сохранении звук берётся с главной камеры', () => {
  const p = newProject();
  const m0 = vid('cam0', 20), m1 = vid('cam1', 25);
  p.media.push(m0, m1);
  p.multicam = [{ id: 'g', name: 'М', angles: [{ mediaId: 'cam0', offset: 0 }, { mediaId: 'cam1', offset: 3 }], audio: 0 }];
  mainTrack(p).clips.push(makeMediaClip(m1, { in: 8, out: 12, cam: { group: 'g', angle: 1 } }));
  layoutProject(p);
  const plan = buildExportArgs(p, [], { outPath: '/o.mp4', format: 'mp4', width: 1920, height: 1080, fps: 30, quality: 'good', encoder: 'cpu' });
  const s = plan.args.join(' ');
  assert.ok(s.includes('/v/cam0.mp4'), 'файл главной камеры подключён для звука');
});

// ── слежение за объектом ──
test('слежение: образец находится на сдвинутой картинке', () => {
  const W = 120, H = 80;
  // плавный фон и «предмет» — светлое пятно с тёмной точкой сбоку (как в настоящем видео, без резких полосок)
  const frame = (ox: number, oy: number): Gray => {
    const d = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const bx = x - ox - 7, by = y - oy - 7, dx = x - ox - 10, dy = y - oy - 4;
      d[y * W + x] = 60 + 20 * Math.sin(x / 13) * Math.cos(y / 11) + 150 * Math.exp(-(bx * bx + by * by) / 18) - 90 * Math.exp(-(dx * dx + dy * dy) / 3);
    }
    return { w: W, h: H, d };
  };
  const f0 = frame(30, 20);
  const tpl: Gray = { w: 14, h: 14, d: new Float32Array(14 * 14) };
  for (let y = 0; y < 14; y++) for (let x = 0; x < 14; x++) tpl.d[y * 14 + x] = f0.d[(20 + y) * W + 30 + x];
  const m = matchTemplate(frame(39, 26), tpl, 37, 27, 14);
  assert.ok(Math.abs(m.x - 46) <= 1 && Math.abs(m.y - 33) <= 1, `нашлось ${m.x},${m.y}`);
  assert.ok(m.score > 0.9);
});

test('слежение: надпись едет за объектом, размытие повторяет рамку', () => {
  const p = newProject();
  const m = vid('v', 10);
  p.media.push(m);
  const c = makeMediaClip(m, { in: 0, out: 10 });
  c.track = { samples: [{ t: 0, x: 0.2, y: 0.5, w: 0.1, h: 0.1 }, { t: 10, x: 0.8, y: 0.5, w: 0.1, h: 0.1 }] };
  mainTrack(p).clips.push(c);
  const t = p.tracks.find(x => x.kind === 'text') || (p.tracks.push({ id: 'tt', kind: 'text', name: 'Т', muted: false, locked: false, hidden: false, clips: [] }), p.tracks[p.tracks.length - 1]);
  const tc: TextClip = makeTextClip('Смотри', 2, 4);
  tc.follow = { clipId: c.id };
  t.clips.push(tc);
  layoutProject(p);
  const q = structuredClone(p);
  resolveFollows(q);
  const qt = q.tracks.flatMap(x => x.clips).find(x => x.id === tc.id) as TextClip;
  assert.ok(qt.path && qt.path.length > 10);
  assert.ok(Math.abs(textShift(qt, 0).x) < 1e-6, 'в начале надпись на своём месте');
  assert.ok(Math.abs(textShift(qt, 4).x - 0.24) < 0.02, `через 4 с сдвиг ${textShift(qt, 4).x}`);
  assert.ok(!(p.tracks.flatMap(x => x.clips).find(x => x.id === tc.id) as TextClip).path, 'сам проект не меняется');
  const s = trackAt(c.track, 5)!;
  assert.ok(Math.abs(s.x - 0.5) < 1e-6);
  const blur = trackToBlur(c.track, 0, 10);
  assert.ok(blur.samples.length >= 50 && blur.samples.every(x => x.boxes.length === 1));
});

// ── вложенные клипы ──
test('вложенные клипы: объединить и разобрать обратно', () => {
  const p = newProject();
  const a = vid('a', 5), b = vid('b', 5), c3 = vid('c', 5), mus = aud('mus');
  p.media.push(a, b, c3, mus);
  const main = mainTrack(p);
  const ca = makeMediaClip(a), cb = makeMediaClip(b), cc = makeMediaClip(c3);
  main.clips.push(ca, cb, cc);
  p.tracks.push({ id: 'tx', kind: 'text', name: 'Текст', muted: false, locked: false, hidden: false, clips: [makeTextClip('Внутри', 6, 2), makeTextClip('Снаружи', 12, 2)] });
  p.tracks.push({ id: 'au', kind: 'audio', name: 'Музыка', muted: false, locked: false, hidden: false, clips: [makeMediaClip(mus, { start: 0, out: 15 })] });
  layoutProject(p);
  assert.ok('error' in planGroup(p, [ca.id, cc.id]), 'с пропуском нельзя');
  const plan = planGroup(p, [ca.id, cb.id]);
  assert.ok(!('error' in plan));
  if ('error' in plan) return;
  assert.equal(plan.start, 0); assert.equal(plan.end, 10);
  assert.deepEqual(plan.layers.map(l => l.ids.length), [1]);
  const part = groupProject(p, plan);
  assert.equal(mainTrack(part).clips.length, 2);
  assert.ok(!part.tracks.some(t => t.kind === 'audio'), 'музыка остаётся снаружи');
  const g = applyGroup(p, plan, 'nested', 10, 'Вложенный');
  assert.equal(mainTrack(p).clips.length, 2);
  assert.equal(p.tracks.find(t => t.id === 'tx')!.clips.length, 1);
  assert.equal(clipEnd(mainTrack(p).clips[1]), 15);
  const back = ungroup(p, g.id);
  assert.equal(back.length, 3);
  assert.equal(mainTrack(p).clips.length, 3);
  assert.equal(p.tracks.find(t => t.id === 'tx')!.clips.length, 2);
});

// ── проверка перед публикацией ──
test('проверка: разбор отчёта FFmpeg и советы', () => {
  const log = `[blackdetect @ 0x1] black_start:0 black_end:0.4 black_duration:0.4
[silencedetect @ 0x2] silence_start: 12.5
[silencedetect @ 0x2] silence_end: 17.1 | silence_duration: 4.6
[blackdetect @ 0x1] black_start:30.2 black_end:32.6 black_duration:2.4
[freezedetect @ 0x3] lavfi.freezedetect.freeze_start: 40
[freezedetect @ 0x3] lavfi.freezedetect.freeze_end: 47
[Parsed_ebur128_0 @ 0x4] Summary:
  Integrated loudness:
    I:         -23.4 LUFS
  True peak:
    Peak:       -0.2 dBFS`;
  const a = parseAnalysis(log, 60);
  assert.equal(a.lufs, -23.4);
  assert.equal(a.peak, -0.2);
  assert.equal(a.blacks.length, 2);
  assert.deepEqual(a.silences, [{ start: 12.5, end: 17.1 }]);
  const issues = sortIssues(analysisIssues(a, 60, -14));
  const ids = issues.map(i => i.id);
  assert.ok(ids.includes('quiet') && ids.includes('peak'));
  assert.ok(ids.includes('silence:12.5'));
  assert.ok(ids.includes('black:30.2') && !ids.includes('black:0'), 'появление из чёрного в начале — норма');
  assert.ok(ids.includes('freeze:40'));
  assert.equal(issues.find(i => i.id === 'quiet')!.fix?.kind, 'loudness');
});

test('проверка: обрезанная надпись, музыка в конце и пустой проект', () => {
  const empty = newProject();
  assert.ok(staticChecks(empty).some(i => i.level === 'error'));
  const p = newProject('В', 1080, 1920);
  const v = vid('v', 10), mus = aud('mus', 60);
  p.media.push(v, mus);
  mainTrack(p).clips.push(makeMediaClip(v));
  const tc = makeTextClip('Подпишись', 1, 3);
  p.tracks.push({ id: 'tx', kind: 'text', name: 'Т', muted: false, locked: false, hidden: false, clips: [tc] });
  p.tracks.push({ id: 'au', kind: 'audio', name: 'М', muted: false, locked: false, hidden: false, clips: [makeMediaClip(mus, { start: 0, out: 10 })] });
  layoutProject(p);
  const issues = staticChecks(p, [{ clipId: tc.id, x: 0.3, y: 0.9, w: 0.5, h: 0.08 }]);
  const kinds = issues.map(i => i.fix?.kind);
  assert.ok(kinds.includes('move-text'), 'надпись под кнопками приложения');
  assert.ok(kinds.includes('fade-music'), 'музыка обрывается в конце');
});

// ── черновик ──
test('черновик: ответ нейросети проверяется и подгоняется к словам', () => {
  const words = [{ w: 'Привет', s: 0.5, e: 0.9 }, { w: 'это', s: 1.0, e: 1.2 }, { w: 'обзор', s: 1.3, e: 1.9 }, { w: 'кухни', s: 2.0, e: 2.6 }];
  const sources = [{ media: vid('a', 30), words }, { media: { ...vid('ph', 5), kind: 'image' as const } }];
  const plan = parseDraft('Вот план: {"title":"Кухня мечты","pieces":[{"file":1,"start":1.1,"end":2.3},{"file":2,"start":0,"end":3},{"file":7,"start":0,"end":3},{"file":1,"start":5,"end":5.2}]}', sources);
  assert.equal(plan.title, 'Кухня мечты');
  assert.equal(plan.pieces.length, 2, 'чужие файлы и крошечные куски отбрасываются');
  assert.ok(plan.pieces[0].start <= 1.0 && plan.pieces[0].end >= 2.6, 'слова не режутся пополам');
  assert.throws(() => parseDraft('не знаю', sources));
  const sn = snapToWords(words, 0.7, 1.1);
  assert.ok(Math.abs(sn.start - 0.42) < 1e-9 && Math.abs(sn.end - 1.32) < 1e-9);
  const fb = fallbackDraft(sources, 20);
  assert.equal(fb.pieces.length, 2);
});

// ── длинный путь движения: раньше FFmpeg не разбирал больше ~100 вложенных if ──
test('путь из сотен точек: выражение неглубокое и считается верно', () => {
  const pts = Array.from({ length: 400 }, (_, i) => ({ t: i / 15, v: 0.5 + 0.3 * Math.sin(i / 20) }));
  const e = pathExpr(pts, 'T');
  let depth = 0, max = 0;
  for (const ch of e) { if (ch === '(') max = Math.max(max, ++depth); else if (ch === ')') depth--; }
  assert.ok(max < 40, `глубина скобок ${max}`);
  const fn = new Function('T', 'iff', 'lt', 'gte', 'return ' + e.replace(/\bif\(/g, 'iff('));
  const val = (T: number) => fn(T, (c: number, a: number, b: number) => (c ? a : b), (a: number, b: number) => (a < b ? 1 : 0), (a: number, b: number) => (a >= b ? 1 : 0));
  for (const T of [0, 1.234, 7.5, 13.3, 26.6, 40]) {
    const want = 0.5 + 0.3 * Math.sin(Math.min(399, T * 15) / 20);
    assert.ok(Math.abs(val(T) - want) < 0.004, `T=${T}: ${val(T)} ≈ ${want}`);
  }
  assert.ok(simplifyPath(pts).length < pts.length);
});

test('надпись едет за объектом и в готовом видео', { skip: !hasFF }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'follow-'));
  const src = join(dir, 'v.mp4'), png = join(dir, 't.png'), out = join(dir, 'o.mp4');
  assert.equal(spawnSync(ff, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30:d=8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]).status, 0);
  // «надпись» — белый квадрат 20×20 в центре прозрачного кадра
  assert.equal(spawnSync(ff, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', "color=c=black:s=320x180,format=rgba,geq=r=255:g=255:b=255:a='255*between(X,150,169)*between(Y,80,99)'", '-frames:v', '1', png]).status, 0);
  const p = newProject('f', 320, 180, 30);
  const m: MediaItem = { id: 'v', path: src, name: 'v', kind: 'video', duration: 8, width: 320, height: 180, hasAudio: false, fps: 30, size: 1 };
  p.media.push(m);
  const c = makeMediaClip(m);
  // объект едет слева направо: от 0.2 до 0.8 ширины за 8 секунд
  c.track = { samples: Array.from({ length: 121 }, (_, i) => ({ t: i / 15, x: 0.2 + 0.6 * (i / 120), y: 0.5, w: 0.1, h: 0.1 })) };
  mainTrack(p).clips.push(c);
  const tc = makeTextClip('•', 0, 8, { x: 0.5, y: 0.5 });
  tc.follow = { clipId: c.id };
  tc.animIn = 'none'; tc.animOut = 'none';
  p.tracks.push({ id: 'tx', kind: 'text', name: 'Т', muted: false, locked: false, hidden: false, clips: [tc] });
  layoutProject(p);
  const plan = buildExportArgs(p, [{ clipId: tc.id, path: png }], { outPath: out, format: 'mp4', width: 320, height: 180, fps: 30, quality: 'best', encoder: 'cpu' }, { tempDir: dir, blank: join(dir, 'blank.png') });
  for (const f of plan.files) writeFileSync(f.path, f.content);
  const r = spawnSync(ff, plan.args, { maxBuffer: 1 << 26 });
  assert.equal(r.status, 0, r.stderr.toString().slice(-1500));
  const lum = (t: number, x: number) => spawnSync(ff, ['-loglevel', 'error', '-ss', String(t), '-i', out, '-frames:v', '1', '-vf', `format=gray,crop=1:1:${x}:90`, '-f', 'rawvideo', '-']).stdout[0];
  // в начале квадрат в центре (160), к 6-й секунде сдвинулся на 0.45 ширины вправо (≈ 304)
  assert.ok(lum(0.1, 160) > 200, 'в начале надпись на месте');
  assert.ok(lum(6, 160) < 60 && lum(6, 160 + Math.round(0.45 * 320) - 2) > 200, 'потом едет за объектом');
});
