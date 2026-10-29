// Превращает проект «Кадра» в команду FFmpeg. Чистая функция: её легко проверить тестами.
import type { ExportOptions, MediaClip, MediaItem, Project, TextClip, TextRender } from './types';
import { COLOR_PRESETS, clipDuration, layoutProject, projectDuration, transitionDuration } from './timeline';

export interface ExportPlan {
  args: string[];
  duration: number;
}

const n = (v: number, d = 4) => {
  const s = (Math.round(v * 10 ** d) / 10 ** d).toString();
  return s === '-0' ? '0' : s;
};

function colorFilters(c: MediaClip): string[] {
  const f: string[] = [];
  const col = c.color;
  const preset = COLOR_PRESETS[col.preset]?.ff;
  if (preset) f.push(preset);
  if (col.brightness || col.contrast !== 1 || col.saturation !== 1 || col.gamma !== 1) {
    f.push(`eq=brightness=${n(col.brightness * 0.5)}:contrast=${n(col.contrast)}:saturation=${n(col.saturation)}:gamma=${n(col.gamma)}`);
  }
  if (col.temperature) f.push(`colortemperature=temperature=${Math.round(6500 - col.temperature * 3000)}`);
  const fx = c.effects;
  if (fx.flipH) f.push('hflip');
  if (fx.flipV) f.push('vflip');
  if (fx.blur > 0) f.push(`gblur=sigma=${n(fx.blur * 25, 2)}`);
  if (fx.sharpen > 0) f.push(`unsharp=5:5:${n(fx.sharpen * 2.5, 2)}`);
  if (fx.grain > 0) f.push(`noise=alls=${Math.round(fx.grain * 40)}:allf=t`);
  if (fx.vignette > 0) f.push(`vignette=angle=${n(0.2 + fx.vignette * 0.9, 3)}`);
  return f;
}

// Размер слоя в пикселях при масштабе 1 (вписать или заполнить кадр)
export function baseLayerSize(m: MediaItem, fit: 'fit' | 'fill', W: number, H: number): { w: number; h: number } {
  const mw = m.width || W, mh = m.height || H;
  const k = fit === 'fill' ? Math.max(W / mw, H / mh) : Math.min(W / mw, H / mh);
  return { w: mw * k, h: mh * k };
}

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

/**
 * Цепочка фильтров одного слоя видео/картинки.
 * Возвращает фильтры и выражения x/y для overlay. tOrigin — момент начала клипа во времени overlay.
 */
function layerChain(c: MediaClip, m: MediaItem, W: number, H: number, fps: number, tOrigin: number) {
  const dur = clipDuration(c);
  const f: string[] = ['setpts=PTS-STARTPTS'];
  if (c.speed !== 1) f.push(`setpts=PTS/${n(c.speed)}`);
  f.push(`fps=${fps}`);
  f.push(...colorFilters(c));
  const base = baseLayerSize(m, c.fit, W, H);
  const a = c.transform, b = c.animate ? c.transformEnd : c.transform;
  const k = `clip((t-${n(tOrigin)})/${n(dur)},0,1)`;
  const lerp = (u: number, v: number) => (u === v ? n(u) : `(${n(u)}+(${n(v - u)})*${k})`);
  // Для «заполнить» обрезаем лишнее за пределами кадра только когда масштаб не анимируется
  const fillCrop = c.fit === 'fill' && a.scale === b.scale;
  if (a.scale === b.scale) {
    f.push(`scale=${even(base.w * a.scale)}:${even(base.h * a.scale)}`);
    if (fillCrop && a.x === 0.5 && a.y === 0.5 && a.rotation === 0 && b.rotation === 0) {
      f.push(`crop=${even(Math.min(base.w * a.scale, W * Math.max(1, a.scale)))}:${even(Math.min(base.h * a.scale, H * Math.max(1, a.scale)))}`);
    }
  } else {
    // масштаб меняется во времени: t внутри scale — локальное время слоя
    const lk = `clip(t/${n(dur)},0,1)`;
    const s = `(${n(a.scale)}+(${n(b.scale - a.scale)})*${lk})`;
    f.push(`scale=w='2*trunc(${n(base.w)}*${s}/2)':h='2*trunc(${n(base.h)}*${s}/2)':eval=frame`);
  }
  f.push('format=yuva420p');
  if (a.scale !== b.scale) {
    // Размер кадра меняется каждый кадр, а поворот, затухание и прозрачность в новых FFmpeg
    // так не умеют. Кладём слой на прозрачный холст постоянного размера по центру.
    const smax = Math.max(a.scale, b.scale);
    const pw = Math.max(2, Math.ceil((base.w * smax) / 2) * 2), ph = Math.max(2, Math.ceil((base.h * smax) / 2) * 2);
    f.push(`pad=w=${pw}:h=${ph}:x='(ow-iw)/2':y='(oh-ih)/2':color=black@0:eval=frame`);
  }
  if (a.rotation || b.rotation) {
    const smax = Math.max(a.scale, b.scale);
    const diag = even(Math.hypot(base.w * smax, base.h * smax));
    const lk = `clip(t/${n(dur)},0,1)`;
    const ang = a.rotation === b.rotation ? n((a.rotation * Math.PI) / 180) : `(${n((a.rotation * Math.PI) / 180)}+(${n(((b.rotation - a.rotation) * Math.PI) / 180)})*${lk})`;
    f.push(`rotate=a='${ang}':ow=${diag}:oh=${diag}:c=none`);
  }
  const op = a.opacity;
  if (op < 1) f.push(`colorchannelmixer=aa=${n(op, 3)}`);
  if (c.fadeIn > 0) f.push(`fade=t=in:st=0:d=${n(Math.min(c.fadeIn, dur))}:alpha=1`);
  if (c.fadeOut > 0) f.push(`fade=t=out:st=${n(Math.max(0, dur - c.fadeOut))}:d=${n(Math.min(c.fadeOut, dur))}:alpha=1`);
  const x = `'${lerp(a.x, b.x)}*W-w/2'`;
  const y = `'${lerp(a.y, b.y)}*H-h/2'`;
  return { filters: f, x, y, dur };
}

function atempoChain(speed: number): string[] {
  const out: string[] = [];
  let s = speed;
  while (s > 2) { out.push('atempo=2'); s /= 2; }
  while (s < 0.5) { out.push('atempo=0.5'); s /= 0.5; }
  if (Math.abs(s - 1) > 1e-6) out.push(`atempo=${n(s)}`);
  return out;
}

function textOverlay(c: TextClip) {
  const d = Math.max(0.01, Math.min(c.animDuration, c.duration / 2));
  const st = c.start, end = c.start + c.duration;
  const ein = `(1-pow(1-clip((t-${n(st)})/${n(d)},0,1),3))`;
  const eout = `(1-pow(1-clip((${n(end)}-t)/${n(d)},0,1),3))`;
  const dx: string[] = [], dy: string[] = [];
  const add = (anim: string, e: string) => {
    const off = `(1-${e})*0.08`;
    if (anim === 'slide-up') dy.push(`+${off}*H`);
    if (anim === 'slide-down') dy.push(`-${off}*H`);
    if (anim === 'slide-left') dx.push(`+${off}*W`);
    if (anim === 'slide-right') dx.push(`-${off}*W`);
  };
  add(c.animIn, ein);
  add(c.animOut, eout);
  const f: string[] = ['format=rgba'];
  if (c.animIn !== 'none') f.push(`fade=t=in:st=0:d=${n(d)}:alpha=1`);
  if (c.animOut !== 'none') f.push(`fade=t=out:st=${n(Math.max(0, c.duration - d))}:d=${n(d)}:alpha=1`);
  const zoom = c.animIn === 'zoom' || c.animOut === 'zoom';
  if (zoom) {
    const lin = `(1-pow(1-clip(t/${n(d)},0,1),3))`;
    const lout = `(1-pow(1-clip((${n(c.duration)}-t)/${n(d)},0,1),3))`;
    const parts: string[] = [];
    if (c.animIn === 'zoom') parts.push(`(0.7+0.3*${lin})`);
    if (c.animOut === 'zoom') parts.push(`(0.7+0.3*${lout})`);
    const s = parts.join('*');
    f.push(`scale=w='2*trunc(iw*${s}/2)':h='2*trunc(ih*${s}/2)':eval=frame`);
  }
  const x = `'(W-w)/2${dx.join('')}'`;
  const y = `'(H-h)/2${dy.join('')}'`;
  return { filters: f, x, y };
}

export function buildExportArgs(
  projectIn: Project,
  texts: TextRender[],
  opts: ExportOptions,
): ExportPlan {
  const p: Project = JSON.parse(JSON.stringify(projectIn));
  layoutProject(p);
  const W = even(p.width), H = even(p.height), fps = p.fps;
  const total = Math.max(0.5, projectDuration(p));
  const mediaMap = new Map(p.media.map(m => [m.id, m]));
  const textMap = new Map(texts.map(t => [t.clipId, t.path]));

  const inputs: string[] = [];
  let inputCount = 0;
  const addInput = (args: string[]) => { inputs.push(...args); return inputCount++; };
  const graph: string[] = [];
  let label = 0;
  const L = (pfx: string) => `${pfx}${label++}`;
  const bg = p.background.replace('#', '0x');
  const audioOnly = opts.format === 'mp3' || opts.format === 'wav';

  const mediaInput = (c: MediaClip, m: MediaItem) => {
    const len = Math.max(0.05, c.out - c.in);
    if (m.kind === 'image') {
      return addInput(['-loop', '1', '-framerate', String(fps), '-t', n(clipDuration(c) + 0.1), '-i', m.path]);
    }
    return addInput(['-ss', n(c.in), '-t', n(len), '-i', m.path]);
  };

  // ── Видео: главная дорожка ─────────────────────────────
  const voiceAudio: string[] = [];
  const duckAudio: string[] = [];
  const mainTrack = p.tracks.find(t => t.kind === 'main')!;
  const mainClips = mainTrack.clips.filter((c): c is MediaClip => c.type === 'media' && mediaMap.has(c.mediaId));
  const inputIndex = new Map<string, number>();
  const ensureInput = (c: MediaClip) => {
    if (!inputIndex.has(c.id)) inputIndex.set(c.id, mediaInput(c, mediaMap.get(c.mediaId)!));
    return inputIndex.get(c.id)!;
  };

  let vAcc = '';
  if (!audioOnly) {
    if (mainClips.length && !mainTrack.hidden) {
      let accEnd = 0;
      mainClips.forEach((c, i) => {
        const m = mediaMap.get(c.mediaId)!;
        if (m.kind === 'audio') return;
        const idx = ensureInput(c);
        const { filters, x, y, dur } = layerChain(c, m, W, H, fps, 0);
        const lay = L('l'), bgl = L('b'), out = L('m');
        graph.push(`[${idx}:v]${filters.join(',')}[${lay}]`);
        graph.push(`color=c=${bg}:s=${W}x${H}:r=${fps}:d=${n(dur)},format=yuva420p[${bgl}]`);
        graph.push(`[${bgl}][${lay}]overlay=x=${x}:y=${y}:eval=frame:eof_action=pass,trim=duration=${n(dur)},format=yuv420p,setsar=1[${out}]`);
        if (!vAcc) { vAcc = out; accEnd = c.start + dur; return; }
        const prev = mainClips[i - 1];
        const td = transitionDuration(prev, c);
        const nx = L('s');
        if (td > 0 && c.transition) {
          graph.push(`[${vAcc}][${out}]xfade=transition=${c.transition.type}:duration=${n(td)}:offset=${n(c.start)}[${nx}]`);
        } else {
          graph.push(`[${vAcc}][${out}]concat=n=2:v=1:a=0[${nx}]`);
        }
        vAcc = nx;
        accEnd = c.start + dur;
      });
      if (vAcc && accEnd < total - 1e-3) {
        const nx = L('s');
        graph.push(`[${vAcc}]tpad=stop_mode=add:stop_duration=${n(total - accEnd)}:color=${bg}[${nx}]`);
        vAcc = nx;
      }
    }
    if (!vAcc) {
      vAcc = L('s');
      graph.push(`color=c=${bg}:s=${W}x${H}:r=${fps}:d=${n(total)},format=yuv420p[${vAcc}]`);
    }

    // ── Видео: дорожки наложения и текста (снизу вверх) ───
    for (const track of p.tracks) {
      if (track.kind === 'main' || track.kind === 'audio' || track.hidden) continue;
      for (const c of track.clips) {
        if (c.type === 'media') {
          const m = mediaMap.get(c.mediaId);
          if (!m || m.kind === 'audio') continue;
          const idx = ensureInput(c);
          const { filters, x, y, dur } = layerChain(c, m, W, H, fps, c.start);
          const lay = L('l'), nx = L('s');
          graph.push(`[${idx}:v]${filters.join(',')},setpts=PTS+${n(c.start)}/TB[${lay}]`);
          graph.push(`[${vAcc}][${lay}]overlay=x=${x}:y=${y}:eval=frame:eof_action=pass:enable='between(t,${n(c.start)},${n(c.start + dur)})'[${nx}]`);
          vAcc = nx;
        } else if (c.type === 'text') {
          const png = textMap.get(c.id);
          if (!png) continue;
          const idx = addInput(['-loop', '1', '-framerate', String(fps), '-t', n(c.duration), '-i', png]);
          const { filters, x, y } = textOverlay(c);
          const lay = L('l'), nx = L('s');
          graph.push(`[${idx}:v]${filters.join(',')},setpts=PTS+${n(c.start)}/TB[${lay}]`);
          graph.push(`[${vAcc}][${lay}]overlay=x=${x}:y=${y}:eval=frame:eof_action=pass:enable='between(t,${n(c.start)},${n(c.start + c.duration)})'[${nx}]`);
          vAcc = nx;
        }
      }
    }
  }

  // ── Звук ──────────────────────────────────────────────
  for (const track of p.tracks) {
    if (track.muted) continue;
    const clips = track.clips;
    clips.forEach((c, i) => {
      if (c.type !== 'media' || c.muted || c.volume <= 0) return;
      const m = mediaMap.get(c.mediaId);
      if (!m || !m.hasAudio || m.kind === 'image') return;
      const idx = ensureInput(c);
      const dur = clipDuration(c);
      const f: string[] = ['asetpts=PTS-STARTPTS', 'aresample=48000', 'aformat=channel_layouts=stereo', ...atempoChain(c.speed)];
      if (c.volume !== 1) f.push(`volume=${n(c.volume, 3)}`);
      let fi = c.audioFadeIn, fo = c.audioFadeOut;
      if (track.kind === 'main') {
        fi = Math.max(fi, transitionDuration(clips[i - 1], c));
        const next = clips[i + 1];
        if (next && next.type === 'media') fo = Math.max(fo, transitionDuration(c, next));
      }
      if (fi > 0) f.push(`afade=t=in:st=0:d=${n(Math.min(fi, dur))}`);
      if (fo > 0) f.push(`afade=t=out:st=${n(Math.max(0, dur - fo))}:d=${n(Math.min(fo, dur))}`);
      f.push(`atrim=duration=${n(dur)}`);
      const ms = Math.round(c.start * 1000);
      if (ms > 0) f.push(`adelay=${ms}:all=1`);
      const out = L('a');
      graph.push(`[${idx}:a]${f.join(',')}[${out}]`);
      (track.kind === 'audio' && c.duck ? duckAudio : voiceAudio).push(out);
    });
  }

  const mix = (labels: string[]): string => {
    if (labels.length === 1) return labels[0];
    const out = L('x');
    graph.push(`${labels.map(l => `[${l}]`).join('')}amix=inputs=${labels.length}:normalize=0:dropout_transition=0[${out}]`);
    return out;
  };

  let aAcc: string;
  if (!voiceAudio.length && !duckAudio.length) {
    aAcc = L('x');
    graph.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${n(total)}[${aAcc}]`);
  } else if (voiceAudio.length && duckAudio.length) {
    const v = mix(voiceAudio), d = mix(duckAudio);
    const v1 = L('x'), sc = L('x'), ducked = L('x'), out = L('x');
    graph.push(`[${v}]asplit=2[${v1}][${sc}]`);
    graph.push(`[${d}][${sc}]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[${ducked}]`);
    graph.push(`[${v1}][${ducked}]amix=inputs=2:normalize=0:dropout_transition=0[${out}]`);
    aAcc = out;
  } else {
    aAcc = mix([...voiceAudio, ...duckAudio]);
  }
  const aFinal = L('x');
  graph.push(`[${aAcc}]apad=whole_dur=${n(total)},atrim=duration=${n(total)},alimiter=limit=0.97[${aFinal}]`);
  aAcc = aFinal;

  // ── Диапазон и итоговый размер ───────────────────────
  let start = 0, end = total;
  if (opts.format === 'png') {
    start = Math.min(Math.max(0, opts.rangeStart ?? 0), Math.max(0, total - 1 / fps));
    end = start + 1 / fps;
  } else if (opts.rangeStart !== undefined || opts.rangeEnd !== undefined) {
    start = Math.max(0, opts.rangeStart ?? 0);
    end = Math.min(total, opts.rangeEnd ?? total);
    if (end - start < 0.1) end = Math.min(total, start + 0.1);
  }
  const outDur = end - start;
  const ranged = start > 0 || end < total - 1e-6;

  if (!audioOnly) {
    const v = L('v');
    const vf: string[] = [];
    if (ranged) vf.push(`trim=start=${n(start)}:end=${n(end)}`, 'setpts=PTS-STARTPTS');
    const ow = even(opts.width || W), oh = even(opts.height || H);
    if (opts.format === 'gif') {
      const gw = Math.min(ow, 640);
      graph.push(`[${vAcc}]${[...vf, `fps=${Math.min(15, opts.fps || fps)}`, `scale=${gw}:-2:flags=lanczos`, 'split[g1][g2]'].join(',')}`);
      graph.push(`[g1]palettegen=stats_mode=diff[pal]`);
      graph.push(`[g2][pal]paletteuse=dither=bayer:bayer_scale=4[${v}]`);
    } else {
      if (ow !== W || oh !== H) vf.push(`scale=${ow}:${oh}:flags=lanczos`);
      if (opts.fps && opts.fps !== fps) vf.push(`fps=${opts.fps}`);
      vf.push('format=yuv420p');
      graph.push(`[${vAcc}]${vf.join(',')}[${v}]`);
    }
    vAcc = v;
  }
  if (ranged) {
    const a = L('x');
    graph.push(`[${aAcc}]atrim=start=${n(start)}:end=${n(end)},asetpts=PTS-STARTPTS[${a}]`);
    aAcc = a;
  }

  if (opts.format === 'gif' || opts.format === 'png') graph.push(`[${aAcc}]anullsink`);
  const args: string[] = ['-hide_banner', '-y', '-nostdin', '-progress', 'pipe:1', '-nostats', ...inputs];
  args.push('-filter_complex', graph.join(';'));
  if (!audioOnly) args.push('-map', `[${vAcc}]`);
  if (opts.format !== 'gif' && opts.format !== 'png') args.push('-map', `[${aAcc}]`);

  const crf = { draft: 28, good: 21, best: 17 }[opts.quality];
  switch (opts.format) {
    case 'mp4':
    case 'mov': {
      const enc = opts.encoder;
      if (enc === 'nvenc') args.push('-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', String(crf + 2), '-b:v', '0');
      else if (enc === 'qsv') args.push('-c:v', 'h264_qsv', '-global_quality', String(crf + 2));
      else if (enc === 'amf') args.push('-c:v', 'h264_amf', '-rc', 'cqp', '-qp_i', String(crf), '-qp_p', String(crf + 2));
      else args.push('-c:v', 'libx264', '-preset', opts.quality === 'draft' ? 'veryfast' : opts.quality === 'best' ? 'slow' : 'medium', '-crf', String(crf));
      args.push('-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', opts.quality === 'draft' ? '128k' : '192k');
      if (opts.format === 'mp4') args.push('-movflags', '+faststart');
      break;
    }
    case 'webm':
      args.push('-c:v', 'libvpx-vp9', '-crf', String(crf + 10), '-b:v', '0', '-row-mt', '1', '-deadline', opts.quality === 'best' ? 'good' : 'realtime', '-cpu-used', opts.quality === 'best' ? '2' : '5', '-c:a', 'libopus', '-b:a', '160k');
      break;
    case 'gif':
      args.push('-loop', '0');
      break;
    case 'png':
      args.push('-frames:v', '1', '-update', '1');
      break;
    case 'mp3':
      args.push('-c:a', 'libmp3lame', '-b:a', opts.quality === 'draft' ? '128k' : '256k');
      break;
    case 'wav':
      args.push('-c:a', 'pcm_s16le');
      break;
  }
  args.push('-t', n(outDur), opts.outPath);
  return { args, duration: outDur };
}
