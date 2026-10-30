import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildExportArgs } from '../shared/export-graph';
import { makeMediaClip, makeTextClip, newProject, projectDuration, layoutProject } from '../shared/timeline';
import type { MediaItem } from '../shared/types';

const ff = process.env.FFMPEG || 'ffmpeg';
const hasFF = spawnSync(ff, ['-version']).status === 0;
const dir = mkdtempSync(join(tmpdir(), 'kadr-test-'));

function gen(name: string, args: string[]) {
  const out = join(dir, name);
  const r = spawnSync(ff, ['-hide_banner', '-loglevel', 'error', '-y', ...args, out]);
  assert.equal(r.status, 0, r.stderr?.toString());
  return out;
}

function probeDuration(file: string): number {
  const r = spawnSync(ff.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return parseFloat(r.stdout.toString());
}

test('магнитная дорожка: переход наезжает на предыдущий клип', () => {
  const p = newProject();
  const m: MediaItem = { id: 'm1', path: 'a.mp4', name: 'a', kind: 'video', duration: 4, width: 640, height: 360, hasAudio: true, fps: 30, size: 1 };
  p.media.push(m);
  const a = makeMediaClip(m), b = makeMediaClip(m, { transition: { type: 'fade', duration: 1 } });
  p.tracks[0].clips.push(a, b);
  layoutProject(p);
  assert.equal(b.start, 3);
  assert.equal(projectDuration(p), 7);
});

test('полный экспорт через FFmpeg собирается и даёт файл нужной длины', { skip: !hasFF }, () => {
  const video = gen('v.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=4', '-f', 'lavfi', '-i', 'sine=f=440:d=4', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
  const image = gen('i.png', ['-f', 'lavfi', '-i', 'color=c=blue:s=400x600', '-frames:v', '1']);
  const music = gen('m.mp3', ['-f', 'lavfi', '-i', 'sine=f=220:d=10']);
  const textPng = gen('t.png', ['-f', 'lavfi', '-i', 'color=c=yellow:s=280x80,format=rgba,pad=1280:720:500:300:color=black@0', '-frames:v', '1']);
  const p = newProject('Тест', 1280, 720, 30);
  const mv: MediaItem = { id: 'v', path: video, name: 'v', kind: 'video', duration: 4, width: 640, height: 360, hasAudio: true, fps: 30, size: 1 };
  const mi: MediaItem = { id: 'i', path: image, name: 'i', kind: 'image', duration: 5, width: 400, height: 600, hasAudio: false, fps: 30, size: 1 };
  const mm: MediaItem = { id: 'm', path: music, name: 'm', kind: 'audio', duration: 10, width: 0, height: 0, hasAudio: true, fps: 0, size: 1 };
  p.media.push(mv, mi, mm);
  const c1 = makeMediaClip(mv, { in: 0.5, out: 3.5, speed: 1.5 });
  c1.color.preset = 'vintage'; c1.effects.vignette = 0.5; c1.color.temperature = 0.4;
  const c2 = makeMediaClip(mi, { out: 3, fit: 'fill', animate: true, transition: { type: 'circleopen', duration: 0.8 } });
  c2.transformEnd = { ...c2.transformEnd, scale: 1.3, rotation: 5 };
  const c3 = makeMediaClip(mv, { transition: { type: 'slideleft', duration: 0.5 }, speed: 0.5, in: 0, out: 1.5 });
  p.tracks[0].clips.push(c1, c2, c3);
  const pip = makeMediaClip(mv, { start: 1, out: 2, transform: { x: 0.8, y: 0.2, scale: 0.3, rotation: 0, opacity: 0.8 }, fadeIn: 0.3 });
  p.tracks[1].clips.push(pip);
  const t = makeTextClip('Привет', 0.5, 2.5); t.animIn = 'slide-up'; t.animOut = 'zoom';
  p.tracks[2].clips.push(t);
  p.tracks[3].clips.push(makeMediaClip(mm, { start: 0, out: 6, duck: true, volume: 0.6, audioFadeOut: 1 }));
  layoutProject(p);
  const total = projectDuration(p);
  for (const format of ['mp4', 'gif', 'mp3'] as const) {
    const out = join(dir, 'out.' + format);
    const plan = buildExportArgs(p, [{ clipId: t.id, path: textPng }], { outPath: out, format, width: 1280, height: 720, fps: 30, quality: 'draft', encoder: 'cpu' });
    const r = spawnSync(ff, plan.args, { maxBuffer: 1 << 26 });
    assert.equal(r.status, 0, format + ': ' + r.stderr.toString().slice(-3000));
    assert.ok(existsSync(out));
    if (format !== 'gif') assert.ok(Math.abs(probeDuration(out) - total) < 0.25, `${format} длина ${probeDuration(out)} вместо ${total}`);
  }
  // диапазон
  const out = join(dir, 'range.mp4');
  const plan = buildExportArgs(p, [{ clipId: t.id, path: textPng }], { outPath: out, format: 'mp4', width: 640, height: 360, fps: 30, quality: 'draft', encoder: 'cpu', rangeStart: 1, rangeEnd: 3 });
  const r = spawnSync(ff, plan.args);
  assert.equal(r.status, 0, r.stderr.toString().slice(-2000));
  assert.ok(Math.abs(probeDuration(out) - 2) < 0.2);
});
