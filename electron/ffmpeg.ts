// Работа с FFmpeg: поиск программы, сведения о файлах, миниатюры, волны звука, анализ, экспорт.
import { app } from 'electron';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import type { MediaItem, MediaKind } from '../shared/types';

const exe = process.platform === 'win32' ? '.exe' : '';

function findBinary(name: 'ffmpeg' | 'ffprobe'): string {
  const candidates = [
    app.isPackaged ? join(process.resourcesPath, 'ffmpeg', name + exe) : '',
    join(app.getAppPath(), 'resources', 'ffmpeg', process.platform, name + exe),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return name; // из PATH
}

export const FFMPEG = findBinary('ffmpeg');
export const FFPROBE = findBinary('ffprobe');

export function ffmpegAvailable(): { ok: boolean; version: string } {
  try {
    const r = spawnSync(FFMPEG, ['-hide_banner', '-version'], { encoding: 'utf8', windowsHide: true });
    return { ok: r.status === 0, version: (r.stdout || '').split('\n')[0] };
  } catch {
    return { ok: false, version: '' };
  }
}

export function run(bin: string, args: string[], opts: { onStdout?: (s: string) => void; signal?: AbortSignal } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    let child: ChildProcess;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e) });
      return;
    }
    let stdout = '', stderr = '';
    child.stdout?.on('data', d => { const s = d.toString(); stdout += s; opts.onStdout?.(s); if (stdout.length > 4e6) stdout = stdout.slice(-1e6); });
    child.stderr?.on('data', d => { stderr += d.toString(); if (stderr.length > 2e6) stderr = stderr.slice(-5e5); });
    child.on('error', e => resolve({ code: -1, stdout, stderr: stderr + String(e) }));
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }));
    opts.signal?.addEventListener('abort', () => child.kill('SIGKILL'));
  });
}

const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff', '.heic', '.avif'];
const AUDIO_EXT = ['.mp3', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.flac', '.opus', '.wma', '.aiff', '.aif'];

export async function probe(path: string): Promise<Omit<MediaItem, 'id'>> {
  const r = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path]);
  if (r.code !== 0) throw new Error('Не удалось прочитать файл: ' + (r.stderr.split('\n').find(Boolean) || basename(path)));
  const info = JSON.parse(r.stdout);
  const streams: any[] = info.streams || [];
  const v = streams.find(s => s.codec_type === 'video' && !(s.disposition?.attached_pic));
  const a = streams.find(s => s.codec_type === 'audio');
  const ext = extname(path).toLowerCase();
  let kind: MediaKind = 'video';
  if (!v || AUDIO_EXT.includes(ext)) kind = 'audio';
  if (v && (IMAGE_EXT.includes(ext) && ext !== '.gif' || v.codec_name === 'png' || v.codec_name === 'mjpeg' && !a && Number(info.format?.duration || 0) < 0.1)) kind = 'image';
  if (!v && !a) throw new Error('В файле нет ни видео, ни звука');
  let rot = 0;
  const sd = v?.side_data_list?.find((x: any) => x.rotation !== undefined);
  if (sd) rot = Math.abs(Number(sd.rotation)) % 180;
  else if (v?.tags?.rotate) rot = Math.abs(Number(v.tags.rotate)) % 180;
  let width = v ? Number(v.width) : 0, height = v ? Number(v.height) : 0;
  if (rot === 90) [width, height] = [height, width];
  const fpsParts = String(v?.avg_frame_rate || v?.r_frame_rate || '0/1').split('/');
  const fps = Number(fpsParts[1]) ? Number(fpsParts[0]) / Number(fpsParts[1]) : 0;
  const duration = kind === 'image' ? 5 : Number(info.format?.duration || v?.duration || a?.duration || 0);
  return {
    path, name: basename(path), kind, duration, width, height, hasAudio: !!a && kind !== 'image',
    fps: Math.round(fps * 100) / 100, size: Number(info.format?.size || statSync(path).size),
  };
}

function cacheDir(path: string): string {
  let mtime = 0;
  try { mtime = statSync(path).mtimeMs; } catch { /* файл мог пропасть */ }
  const h = createHash('sha1').update(path + ':' + mtime).digest('hex').slice(0, 16);
  const dir = join(app.getPath('userData'), 'cache', h);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function thumbnails(path: string, kind: MediaKind, duration: number): Promise<{ thumb?: string; filmstrip: string[] }> {
  if (kind === 'audio') return { filmstrip: [] };
  const dir = cacheDir(path);
  const thumb = join(dir, 'thumb.jpg');
  if (!existsSync(thumb)) {
    const at = kind === 'image' ? 0 : Math.min(duration * 0.2, 3);
    await run(FFMPEG, ['-hide_banner', '-y', '-ss', String(at), '-i', path, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', thumb]);
  }
  const strip: string[] = [];
  if (kind === 'video') {
    const existing = readdirSync(dir).filter(f => f.startsWith('s_')).sort();
    if (existing.length) strip.push(...existing.map(f => join(dir, f)));
    else {
      const count = Math.max(2, Math.min(24, Math.ceil(duration / 2)));
      const rate = count / Math.max(0.1, duration);
      await run(FFMPEG, ['-hide_banner', '-y', '-i', path, '-vf', `fps=${rate.toFixed(5)},scale=-2:72`, '-frames:v', String(count), '-q:v', '6', join(dir, 's_%03d.jpg')]);
      strip.push(...readdirSync(dir).filter(f => f.startsWith('s_')).sort().map(f => join(dir, f)));
    }
  }
  return { thumb: existsSync(thumb) ? thumb : undefined, filmstrip: strip };
}

export async function waveform(path: string, duration: number): Promise<number[]> {
  const rate = 2000;
  const r = await new Promise<Buffer>(resolve => {
    const child = spawn(FFMPEG, ['-hide_banner', '-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', '-'], { windowsHide: true });
    const chunks: Buffer[] = [];
    child.stdout.on('data', d => chunks.push(d));
    child.on('close', () => resolve(Buffer.concat(chunks)));
    child.on('error', () => resolve(Buffer.alloc(0)));
  });
  const samples = r.length >> 1;
  if (!samples) return [];
  const points = Math.max(50, Math.min(6000, Math.round(duration * 25)));
  const per = Math.max(1, Math.floor(samples / points));
  const out: number[] = [];
  for (let i = 0; i < points && i * per < samples; i++) {
    let peak = 0;
    for (let j = i * per; j < Math.min(samples, (i + 1) * per); j++) {
      const v = Math.abs(r.readInt16LE(j * 2));
      if (v > peak) peak = v;
    }
    out.push(Math.round((peak / 32768) * 1000) / 1000);
  }
  return out;
}

// Паузы в звуке: отрезки тишины в секундах исходника
export async function detectSilence(path: string, from: number, to: number, db: number, minDur: number): Promise<{ start: number; end: number }[]> {
  const r = await run(FFMPEG, ['-hide_banner', '-nostats', '-ss', String(from), '-t', String(to - from), '-i', path, '-vn', '-af', `silencedetect=noise=${db}dB:d=${minDur}`, '-f', 'null', '-']);
  const out: { start: number; end: number }[] = [];
  let cur: number | null = null;
  for (const line of r.stderr.split('\n')) {
    const s = line.match(/silence_start: (-?[\d.]+)/);
    const e = line.match(/silence_end: (-?[\d.]+)/);
    if (s) cur = Math.max(0, Number(s[1]));
    if (e && cur !== null) { out.push({ start: from + cur, end: from + Number(e[1]) }); cur = null; }
  }
  if (cur !== null) out.push({ start: from + cur, end: to });
  return out;
}

// Смена сцен: моменты склеек в секундах исходника
export async function detectScenes(path: string, from: number, to: number, threshold: number): Promise<number[]> {
  const r = await run(FFMPEG, ['-hide_banner', '-nostats', '-ss', String(from), '-t', String(to - from), '-i', path, '-an', '-vf', `scale=320:-2,select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-']);
  const times: number[] = [];
  for (const line of r.stderr.split('\n')) {
    const m = line.match(/pts_time:([\d.]+)/);
    if (m && line.includes('Parsed_showinfo')) times.push(from + Number(m[1]));
  }
  return times.filter(t => t - from > 0.3 && to - t > 0.3);
}

let encoderCache: string[] | null = null;
// Какие ускорители видеокарты реально работают на этом компьютере
export async function hardwareEncoders(): Promise<string[]> {
  if (encoderCache) return encoderCache;
  const list = await run(FFMPEG, ['-hide_banner', '-encoders']);
  const found: string[] = [];
  for (const [id, enc] of [['nvenc', 'h264_nvenc'], ['qsv', 'h264_qsv'], ['amf', 'h264_amf']] as const) {
    if (!list.stdout.includes(enc)) continue;
    const test = await run(FFMPEG, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=256x144:d=0.2', '-c:v', enc, '-f', 'null', '-']);
    if (test.code === 0) found.push(id);
  }
  encoderCache = found;
  return found;
}
