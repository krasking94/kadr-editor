// Обработка клипов в отдельную копию файла: стабилизация и «задом наперёд».
// Копия сразу видна в окне просмотра, а исходный файл остаётся нетронутым.
// Здесь же короткий звуковой отрывок «до/после» и измерение громкости.
import { app } from 'electron';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Project, RampPoint } from '../shared/types';
import { rampDuration, rampFilterGraph } from '../shared/ramp';
import { buildExportArgs, ffPath } from '../shared/export-graph';
import { inputLoad, MAX_INPUTS, narrowToRange } from '../shared/export-parts';
import { FFMPEG, run } from './ffmpeg';

export type ProcessKind = 'stabilize' | 'reverse' | 'ramp';
export interface ProcessOpts { ramp?: RampPoint[]; fps?: number; hasAudio?: boolean }

const jobs = new Map<string, AbortController>();
export const cancelProcess = (id: string) => jobs.get(id)?.abort();

function outDir() {
  const d = join(app.getPath('documents'), 'Хлопушка', 'Обработка');
  mkdirSync(d, { recursive: true });
  return d;
}

const fmt = (v: number) => String(Math.round(v * 1000) / 1000);
const ENCODE = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'];

// Прогресс FFmpeg (-progress pipe:1) в долю 0..1 от длины отрезка
const progressOf = (len: number, cb: (p: number) => void) => (s: string) => {
  const m = [...s.matchAll(/out_time_us=(\d+)/g)].pop();
  if (m) cb(Math.min(1, Number(m[1]) / 1e6 / Math.max(0.01, len)));
};

export async function processClip(jobId: string, kind: ProcessKind, src: string, from: number, to: number, onProgress: (p: number) => void, opts: ProcessOpts = {}): Promise<string> {
  let mtime = 0;
  try { mtime = statSync(src).mtimeMs; } catch { throw new Error('Исходный файл не найден'); }
  const len = Math.max(0.1, to - from);
  const h = createHash('sha1').update([kind, src, mtime, fmt(from), fmt(to), JSON.stringify(opts.ramp || '')].join('|')).digest('hex').slice(0, 12);
  const name = src.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '');
  const suffix = kind === 'stabilize' ? 'без тряски' : kind === 'reverse' ? 'задом наперёд' : 'смена скорости';
  const out = join(outDir(), `${name} — ${suffix} ${h}.mp4`);
  if (existsSync(out)) return out;
  const ctrl = new AbortController();
  jobs.set(jobId, ctrl);
  const work = join(tmpdir(), 'kadr', 'proc_' + h);
  mkdirSync(work, { recursive: true });
  const tmpOut = out + '.part.mp4';
  const base = ['-hide_banner', '-y', '-nostdin', '-progress', 'pipe:1', '-nostats'];
  const fail = (r: { stderr: string }) => {
    if (ctrl.signal.aborted) throw new Error('Отменено');
    throw new Error('FFmpeg: ' + r.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 400));
  };
  try {
    if (kind === 'ramp') {
      // Плавная смена скорости: картинка — одной формулой времени, звук — короткими кусками с atempo
      const { graph, maps } = rampFilterGraph(opts.ramp || [], len, opts.fps || 30, opts.hasAudio !== false);
      const audioArgs = maps.length > 1 ? ['-c:a', 'aac', '-b:a', '192k'] : ['-an'];
      const r = await run(FFMPEG, [...base, '-ss', fmt(from), '-t', fmt(len), '-i', src, '-filter_complex', graph, ...maps.flatMap(m => ['-map', m]),
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', ...audioArgs, '-movflags', '+faststart', tmpOut],
      { signal: ctrl.signal, onStdout: progressOf(rampDuration(opts.ramp || [], len), onProgress) });
      if (r.code !== 0) fail(r);
    } else if (kind === 'stabilize') {
      // Два прохода: сначала FFmpeg изучает, как трясётся камера, потом сглаживает движение
      const trf = join(work, 'motion.trf');
      const r1 = await run(FFMPEG, [...base, '-ss', fmt(from), '-t', fmt(len), '-i', src, '-an', '-vf', `vidstabdetect=shakiness=6:accuracy=12:result=${ffPath(trf)}`, '-f', 'null', '-'],
        { signal: ctrl.signal, onStdout: progressOf(len, p => onProgress(p * 0.45)) });
      if (r1.code !== 0 || !existsSync(trf)) fail(r1);
      const r2 = await run(FFMPEG, [...base, '-ss', fmt(from), '-t', fmt(len), '-i', src,
        '-vf', `vidstabtransform=input=${ffPath(trf)}:smoothing=18:optzoom=1:zoomspeed=0.25:interpol=bicubic,unsharp=5:5:0.6:3:3:0.3`,
        ...ENCODE, tmpOut], { signal: ctrl.signal, onStdout: progressOf(len, p => onProgress(0.45 + p * 0.55)) });
      if (r2.code !== 0) fail(r2);
    } else {
      // Целиком переворачивать длинное видео нельзя — не хватит памяти. Режем на куски по 3 секунды,
      // переворачиваем каждый и склеиваем в обратном порядке.
      const step = 3;
      const parts: string[] = [];
      const count = Math.ceil(len / step - 1e-6);
      for (let i = 0; i < count; i++) {
        const st = from + i * step, d = Math.min(step, to - st);
        if (d <= 0.01) break;
        const part = join(work, `p${String(i).padStart(4, '0')}.mp4`);
        const r = await run(FFMPEG, [...base, '-ss', fmt(st), '-t', fmt(d), '-i', src, '-vf', 'reverse', '-af', 'areverse', ...ENCODE, part],
          { signal: ctrl.signal, onStdout: progressOf(d, p => onProgress((i + p) / count * 0.95)) });
        if (r.code !== 0) fail(r);
        parts.push(part);
      }
      const list = join(work, 'list.ffconcat');
      writeFileSync(list, 'ffconcat version 1.0\n' + parts.reverse().map(p => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n');
      const r = await run(FFMPEG, [...base, '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', tmpOut], { signal: ctrl.signal });
      if (r.code !== 0) fail(r);
    }
    renameSync(tmpOut, out);
    onProgress(1);
    return out;
  } finally {
    jobs.delete(jobId);
    rmSync(work, { recursive: true, force: true });
    if (existsSync(tmpOut)) rmSync(tmpOut, { force: true });
  }
}

// Короткий звуковой отрывок проекта — чтобы послушать обработку голоса до и после
export async function audioSnippet(project: Project, start: number, end: number): Promise<string> {
  const dir = join(tmpdir(), 'kadr');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `snip_${Date.now()}.wav`);
  // в тяжёлом проекте (сотни кусков) берём только ту часть, где лежит отрывок
  const near = inputLoad(project, []) > MAX_INPUTS ? narrowToRange(project, [], start, end) : null;
  if (near) { project = near.project; start -= near.offset; end -= near.offset; }
  const plan = buildExportArgs(project, [], { outPath: out, format: 'wav', width: project.width, height: project.height, fps: project.fps, quality: 'draft', encoder: 'cpu', rangeStart: start, rangeEnd: end });
  const r = await run(FFMPEG, plan.args);
  if (r.code !== 0 || !existsSync(out)) throw new Error('Не удалось подготовить отрывок');
  return out;
}

// Громкость ролика по стандарту EBU R128: средняя (LUFS) и пиковая (дБ)
export async function measureLoudness(project: Project): Promise<{ lufs: number; peak: number; lra: number }> {
  const dir = join(tmpdir(), 'kadr');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `loud_${Date.now()}.wav`);
  const plan = buildExportArgs(project, [], { outPath: out, format: 'wav', width: project.width, height: project.height, fps: project.fps, quality: 'draft', encoder: 'cpu' });
  const args = [...plan.args];
  args.splice(args.length - 1, 1, '-f', 'null', '-');
  const fi = args.indexOf('-filter_complex');
  const mapIdx = args.indexOf('-map');
  const lbl = args[mapIdx + 1].replace(/[[\]]/g, '');
  args[fi + 1] += `;[${lbl}]ebur128=peak=true[meas]`;
  args[mapIdx + 1] = '[meas]';
  return parseLoudness((await run(FFMPEG, args)).stderr);
}

/** Громкость готового звукового файла (для тяжёлых проектов звук сначала сводится по частям) */
export async function measureLoudnessFile(path: string): Promise<{ lufs: number; peak: number; lra: number }> {
  return parseLoudness((await run(FFMPEG, ['-hide_banner', '-nostdin', '-i', path, '-af', 'ebur128=peak=true', '-f', 'null', '-'])).stderr);
}

function parseLoudness(stderr: string): { lufs: number; peak: number; lra: number } {
  const tail = stderr.slice(stderr.lastIndexOf('Summary:'));
  const num = (re: RegExp) => { const m = tail.match(re); return m ? Number(m[1]) : NaN; };
  const lufs = num(/I:\s+(-?[\d.]+) LUFS/), peak = num(/Peak:\s+(-?[\d.]+) dBFS/), lra = num(/LRA:\s+(-?[\d.]+) LU/);
  if (!isFinite(lufs)) throw new Error('Не удалось измерить громкость');
  return { lufs, peak, lra };
}

// Лёгкая копия 540p для плавного просмотра тяжёлых видео (4K, высокий битрейт).
// Частые опорные кадры (каждые 12) — чтобы перемотка по таймлайну была мгновенной.
export async function makeProxy(jobId: string, src: string, duration: number, onProgress: (p: number) => void): Promise<string> {
  let mtime = 0;
  try { mtime = statSync(src).mtimeMs; } catch { throw new Error('Исходный файл не найден'); }
  const h = createHash('sha1').update(['proxy', src, mtime].join('|')).digest('hex').slice(0, 12);
  const d = join(app.getPath('documents'), 'Хлопушка', 'Лёгкие копии');
  mkdirSync(d, { recursive: true });
  const name = src.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '');
  const out = join(d, `${name} ${h}.mp4`);
  if (existsSync(out)) return out;
  const ctrl = new AbortController();
  jobs.set(jobId, ctrl);
  const tmpOut = out + '.part.mp4';
  try {
    const r = await run(FFMPEG, ['-hide_banner', '-y', '-nostdin', '-progress', 'pipe:1', '-nostats', '-i', src,
      '-vf', "scale=w='if(gte(iw,ih),-2,min(540,iw))':h='if(gte(iw,ih),min(540,ih),-2)'",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '27', '-g', '12', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', tmpOut],
    { signal: ctrl.signal, onStdout: progressOf(duration, onProgress) });
    if (ctrl.signal.aborted) throw new Error('Отменено');
    if (r.code !== 0) throw new Error('FFmpeg: ' + r.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 400));
    renameSync(tmpOut, out);
    onProgress(1);
    return out;
  } finally {
    jobs.delete(jobId);
    if (existsSync(tmpOut)) rmSync(tmpOut, { force: true });
  }
}

// ── Удаление фона без зелёного экрана ───────────────────────────────────────────
// 1) FFmpeg раскладывает отрезок на маленькие кадры; 2) окно программы находит на каждом человека
// (нейросеть MediaPipe прямо на компьютере) и присылает маски; 3) FFmpeg собирает видео
// с прозрачным фоном (WebM VP9 с альфа-каналом): его видно в просмотре и можно положить на любой фон.

interface BgJob { src: string; from: number; len: number; fps: number; w: number; h: number; mw: number; mh: number; frames: number; dir: string; out: string; ctrl: AbortController }
const bgJobs = new Map<string, BgJob>();

export async function bgPrepare(jobId: string, src: string, from: number, to: number, srcW: number, srcH: number, srcFps: number): Promise<{ frames: number; mw: number; mh: number; fps: number; done?: string }> {
  let mtime = 0;
  try { mtime = statSync(src).mtimeMs; } catch { throw new Error('Исходный файл не найден'); }
  const len = Math.max(0.1, to - from);
  if (len > 600) throw new Error('Фон можно убрать у отрезка до 10 минут. Разрежьте клип на части.');
  const h = createHash('sha1').update(['nobg2', src, mtime, fmt(from), fmt(to)].join('|')).digest('hex').slice(0, 12);
  const name = src.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '');
  const out = join(outDir(), `${name} — без фона ${h}.webm`);
  const fps = Math.max(10, Math.min(30, Math.round(srcFps || 30)));
  // маска считается в маленьком размере: так быстро, а края сглаживаются при увеличении
  const mw = 256, mh = Math.max(2, Math.round((256 * srcH) / Math.max(1, srcW) / 2) * 2);
  if (existsSync(out)) return { frames: 0, mw, mh, fps, done: out };
  const scale = Math.min(1, 1920 / Math.max(srcW, srcH));
  const w = Math.max(2, Math.round((srcW * scale) / 2) * 2), hh = Math.max(2, Math.round((srcH * scale) / 2) * 2);
  const dir = join(tmpdir(), 'kadr', 'nobg_' + h);
  mkdirSync(dir, { recursive: true });
  const ctrl = new AbortController();
  jobs.set(jobId, ctrl);
  const r = await run(FFMPEG, ['-hide_banner', '-y', '-nostdin', '-ss', fmt(from), '-t', fmt(len), '-i', src, '-an', '-vf', `fps=${fps},scale=${mw}:${mh}:flags=area`, '-pix_fmt', 'rgba', '-f', 'rawvideo', join(dir, 'frames.raw')], { signal: ctrl.signal });
  if (r.code !== 0) {
    jobs.delete(jobId);
    rmSync(dir, { recursive: true, force: true });
    throw new Error(ctrl.signal.aborted ? 'Отменено' : 'FFmpeg: ' + r.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 400));
  }
  const frames = Math.floor(statSync(join(dir, 'frames.raw')).size / (mw * mh * 4));
  writeFileSync(join(dir, 'masks.raw'), '');
  bgJobs.set(jobId, { src, from, len, fps, w, h: hh, mw, mh, frames, dir, out, ctrl });
  return { frames, mw, mh, fps };
}

/** Кусок кадров для нейросети: count кадров начиная с start (RGBA подряд) */
export function bgFrames(jobId: string, start: number, count: number): Uint8Array {
  const j = bgJobs.get(jobId);
  if (!j) throw new Error('Задача не найдена');
  const size = j.mw * j.mh * 4;
  const n = Math.max(0, Math.min(count, j.frames - start));
  const buf = Buffer.alloc(n * size);
  const fd = openSync(join(j.dir, 'frames.raw'), 'r');
  try { readSync(fd, buf, 0, buf.length, start * size); } finally { closeSync(fd); }
  return buf;
}

export function bgWrite(jobId: string, masks: Uint8Array) {
  const j = bgJobs.get(jobId);
  if (!j) throw new Error('Задача не найдена');
  appendFileSync(join(j.dir, 'masks.raw'), masks);
}

export async function bgFinish(jobId: string, onProgress: (p: number) => void): Promise<string> {
  const j = bgJobs.get(jobId);
  if (!j) throw new Error('Задача не найдена');
  const tmpOut = j.out + '.part.webm';
  try {
    // маску увеличиваем, слегка размываем и делаем край чуть жёстче, чтобы не было ореола
    const graph = [
      `[0:v]fps=${j.fps},scale=${j.w}:${j.h},format=yuva420p[v]`,
      `[1:v]scale=${j.w}:${j.h}:flags=bicubic,gblur=sigma=1.5,lutyuv=y='clip((val-70)*1.45,0,255)',format=gray[m]`,
      '[v][m]alphamerge,format=yuva420p[o]',
    ].join(';');
    const r = await run(FFMPEG, ['-hide_banner', '-y', '-nostdin', '-progress', 'pipe:1', '-nostats',
      '-ss', fmt(j.from), '-t', fmt(j.len), '-i', j.src,
      '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${j.mw}x${j.mh}`, '-r', String(j.fps), '-i', join(j.dir, 'masks.raw'),
      '-filter_complex', graph, '-map', '[o]', '-map', '0:a?',
      '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '32', '-deadline', 'good', '-cpu-used', '5', '-row-mt', '1', '-auto-alt-ref', '0',
      '-c:a', 'libopus', '-b:a', '160k', '-shortest', tmpOut], { signal: j.ctrl.signal, onStdout: progressOf(j.len, onProgress) });
    if (r.code !== 0) throw new Error(j.ctrl.signal.aborted ? 'Отменено' : 'FFmpeg: ' + r.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 400));
    renameSync(tmpOut, j.out);
    return j.out;
  } finally {
    bgCleanup(jobId);
    if (existsSync(tmpOut)) rmSync(tmpOut, { force: true });
  }
}

export function bgCleanup(jobId: string) {
  const j = bgJobs.get(jobId);
  jobs.delete(jobId);
  if (!j) return;
  bgJobs.delete(jobId);
  rmSync(j.dir, { recursive: true, force: true });
}
