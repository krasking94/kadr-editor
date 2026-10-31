// Сохранение длинного ролика по частям (см. shared/export-parts.ts). Без зависимостей от Electron —
// поэтому его можно проверить тестом с настоящим FFmpeg.
import { createReadStream, createWriteStream, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExportOptions, Project, TextRender } from '../shared/types';
import { buildExportArgs, codecArgs, levelFilter, PCM_RATE } from '../shared/export-graph';
import { partFrames, sliceProject, type ExportPart } from '../shared/export-parts';
import { projectDuration } from '../shared/timeline';

type RunResult = { code: number; stdout: string; stderr: string };
export interface PartsEnv {
  ffmpeg: string;
  run: (bin: string, args: string[], opts: { onStdout?: (s: string) => void; signal?: AbortSignal }) => Promise<RunResult>;
  workDir: string; // где держать части, пока они не склеены
  log?: (s: string) => void;
}

/**
 * Сохранение по частям: каждая часть — отдельный проход FFmpeg (видео без звука + звук без сжатия ровно той же длины),
 * потом видео склеивается без пересжатия, а звук выравнивается и сжимается один раз на весь ролик.
 */
export async function exportInParts(env: PartsEnv, project: Project, textFiles: TextRender[], opts: ExportOptions, parts: ExportPart[], blank: string | undefined,
  signal: AbortSignal, onProgress?: (p: number, speed: string) => void, finalAudio?: string[]): Promise<{ r: { code: number; stdout: string; stderr: string }; seconds: number }> {
  const started = Date.now();
  const ofps = opts.fps || project.fps;
  const total = projectDuration(project);
  const from = Math.max(0, opts.rangeStart ?? 0), to = Math.min(total, opts.rangeEnd ?? total);
  const list = partFrames(parts, ofps, from, to);
  const totalFrames = list.reduce((a, x) => a + x.frames, 0) || 1;
  const audioOnly = opts.format === 'mp3' || opts.format === 'wav';
  const work = join(env.workDir, `parts_${Date.now().toString(36)}`);
  mkdirSync(work, { recursive: true });
  const audioAll = join(work, 'audio.raw');
  writeFileSync(audioAll, '');
  const videos: string[] = [];
  let done = 0;
  try {
    for (const [k, it] of list.entries()) {
      if (signal.aborted) return { r: { code: -1, stdout: '', stderr: 'Отменено' }, seconds: 0 };
      const sub = sliceProject(project, textFiles, it.part);
      const vOut = join(work, `p${k}.mkv`), aOut = join(work, `p${k}.raw`);
      const rs = it.renderFrom - it.part.start;
      const plan = buildExportArgs(sub.project, sub.texts, { ...opts, outPath: vOut, rangeStart: rs, rangeEnd: rs + it.frames / ofps, loudness: undefined },
        { tempDir: work, blank, part: { frames: it.frames, audioOut: aOut } });
      for (const f of plan.files) writeFileSync(f.path, f.content);
      const r = await env.run(env.ffmpeg, plan.args, {
        signal,
        onStdout: s => {
          const m = [...s.matchAll(/out_time_us=(\d+)/g)].pop();
          const sp = [...s.matchAll(/speed=\s*([\d.]+x)/g)].pop();
          if (m && onProgress) onProgress(Math.min(0.97, (done + Math.min(it.frames, Number(m[1]) / 1e6 * ofps)) / totalFrames * 0.97), sp?.[1] || '');
        },
      });
      if (r.code !== 0 || signal.aborted) return { r, seconds: (Date.now() - started) / 1000 };
      await new Promise<void>((resolve, reject) => {
        const w = createWriteStream(audioAll, { flags: 'a' });
        createReadStream(aOut).on('error', reject).pipe(w).on('finish', () => resolve()).on('error', reject);
      });
      unlinkSync(aOut);
      if (!audioOnly) videos.push(vOut);
      done += it.frames;
    }
    env.log?.(`Сохраняю по частям: ${list.length} частей, ${Math.round(totalFrames / ofps)} с`);
    const c = codecArgs(opts);
    const q = (f: string) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
    const vlist = join(work, 'video.ffconcat');
    if (!audioOnly) writeFileSync(vlist, 'ffconcat version 1.0\n' + videos.map(q).join('\n') + '\n');
    const args = ['-hide_banner', '-y', '-nostdin', '-progress', 'pipe:1', '-nostats',
      ...(audioOnly ? [] : ['-f', 'concat', '-safe', '0', '-i', vlist]),
      '-f', 's16le', '-ar', String(PCM_RATE), '-ac', '2', '-i', audioAll,
      ...(audioOnly ? ['-map', '0:a'] : ['-map', '0:v', '-map', '1:a', '-c:v', 'copy']),
      '-af', levelFilter(opts), ...c.audio, ...(finalAudio || []), ...c.tail, '-t', String(totalFrames / ofps), opts.outPath];
    const r = await env.run(env.ffmpeg, args, {
      signal,
      onStdout: s => { const m = [...s.matchAll(/out_time_us=(\d+)/g)].pop(); if (m && onProgress) onProgress(0.97 + 0.03 * Math.min(1, Number(m[1]) / 1e6 / (totalFrames / ofps)), ''); },
    });
    return { r, seconds: (Date.now() - started) / 1000 };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
