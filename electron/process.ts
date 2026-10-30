// Обработка клипов в отдельную копию файла: стабилизация и «задом наперёд».
// Копия сразу видна в окне просмотра, а исходный файл остаётся нетронутым.
// Здесь же короткий звуковой отрывок «до/после» и измерение громкости.
import { app } from 'electron';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Project } from '../shared/types';
import { buildExportArgs, ffPath } from '../shared/export-graph';
import { FFMPEG, run } from './ffmpeg';

export type ProcessKind = 'stabilize' | 'reverse';

const jobs = new Map<string, AbortController>();
export const cancelProcess = (id: string) => jobs.get(id)?.abort();

function outDir() {
  const d = join(app.getPath('documents'), 'Кадр', 'Обработка');
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

export async function processClip(jobId: string, kind: ProcessKind, src: string, from: number, to: number, onProgress: (p: number) => void): Promise<string> {
  let mtime = 0;
  try { mtime = statSync(src).mtimeMs; } catch { throw new Error('Исходный файл не найден'); }
  const len = Math.max(0.1, to - from);
  const h = createHash('sha1').update([kind, src, mtime, fmt(from), fmt(to)].join('|')).digest('hex').slice(0, 12);
  const name = src.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '');
  const out = join(outDir(), `${name} — ${kind === 'stabilize' ? 'без тряски' : 'задом наперёд'} ${h}.mp4`);
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
    if (kind === 'stabilize') {
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
  const r = await run(FFMPEG, args);
  const tail = r.stderr.slice(r.stderr.lastIndexOf('Summary:'));
  const num = (re: RegExp) => { const m = tail.match(re); return m ? Number(m[1]) : NaN; };
  const lufs = num(/I:\s+(-?[\d.]+) LUFS/), peak = num(/Peak:\s+(-?[\d.]+) dBFS/), lra = num(/LRA:\s+(-?[\d.]+) LU/);
  if (!isFinite(lufs)) throw new Error('Не удалось измерить громкость');
  return { lufs, peak, lra };
}
