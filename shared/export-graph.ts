// Превращает проект «Хлопушки» в команду FFmpeg. Чистая функция: её легко проверить тестами.
import type { ExportOptions, MediaClip, MediaItem, Project, TextClip, TextRender } from './types';
import { COLOR_PRESETS, clipDuration, layoutProject, projectDuration, transitionDuration } from './timeline';
import { isStatic, keyExpr, keysOf, range } from './keyframes';
import { blendOf, croppedMedia, cropFilter, effectiveCrop, eqFilters, faceBlurRadius, maskFilter, wheelsFilter } from './look';
import { resolveFollows } from './track';
import { camAudioSource } from './multicam';

export interface ExportPlan {
  args: string[];
  duration: number;
  files: { path: string; content: string }[]; // служебные файлы, которые нужно записать перед запуском
}

export interface ExportExtras {
  tempDir?: string; // папка для служебных файлов (список картинок субтитров)
  blank?: string; // прозрачная картинка размером с кадр — пауза между субтитрами
}

const n = (v: number, d = 4) => {
  const s = (Math.round(v * 10 ** d) / 10 ** d).toString();
  return s === '-0' ? '0' : s;
};

// Путь к файлу внутри описания фильтра FFmpeg: прямые слэши, экранированные двоеточия и кавычки
export function ffPath(p: string): string {
  // два уровня разбора FFmpeg: граф (кавычки) и параметры фильтра (обратная косая перед двоеточием)
  return "'" + p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\\\\\''") + "'";
}

const hex = (c: string) => '0x' + (c || '#00ff00').replace('#', '').slice(0, 6).padEnd(6, '0');

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

// Кусочно-линейное выражение FFmpeg по точкам пути: значение в момент T (сек от начала клипа)
export function pathExpr(points0: { t: number; v: number }[], T: string): string {
  if (!points0.length) return '0';
  if (points0.length === 1) return n(points0[0].v);
  const points = simplifyPath(points0);
  if (points.length === 1) return n(points[0].v);
  const seg = (i: number) => {
    const a = points[i], b = points[i + 1];
    const dt = Math.max(1e-3, b.t - a.t);
    return a.v === b.v ? n(a.v) : `(${n(a.v)}+(${n(b.v - a.v)})*(${T}-${n(a.t)})/${n(dt)})`;
  };
  // выбор отрезка «делением пополам»: глубина вложенных if растёт как log2, иначе FFmpeg
  // не может разобрать длинный путь (больше ~100 вложенных скобок)
  const tree = (lo: number, hi: number): string => {
    if (lo === hi) return seg(lo);
    const mid = (lo + hi) >> 1;
    return `if(lt(${T},${n(points[mid + 1].t)}),${tree(lo, mid)},${tree(mid + 1, hi)})`;
  };
  const last = points[points.length - 1];
  return `if(lt(${T},${n(points[0].t)}),${n(points[0].v)},if(gte(${T},${n(last.t)}),${n(last.v)},${tree(0, points.length - 2)}))`;
}

/** Убрать точки, которые почти лежат на прямой между соседями (движение не меняется, выражение короче) */
export function simplifyPath(pts: { t: number; v: number }[], eps = 0.0015): { t: number; v: number }[] {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1, dmax = eps;
    for (let i = a + 1; i < b; i++) {
      const k = (pts[i].t - pts[a].t) / Math.max(1e-9, pts[b].t - pts[a].t);
      const d = Math.abs(pts[i].v - (pts[a].v + (pts[b].v - pts[a].v) * k));
      if (d > dmax) { dmax = d; worst = i; }
    }
    if (worst > 0) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * Слой видео или картинки: цепочки фильтров для графа и выражения x/y для overlay.
 * tOrigin — момент начала клипа во времени overlay.
 * Если у клипа включён хромакей, прозрачность считается по исходным цветам (как в окне просмотра),
 * а цветокоррекция применяется отдельно, и потом они соединяются через alphamerge.
 */
function layerChain(c: MediaClip, m: MediaItem, W: number, H: number, fps: number, tOrigin: number, faceInput?: number) {
  const dur = clipDuration(c);
  const pre: string[] = ['setpts=PTS-STARTPTS'];
  const crop = cropFilter(effectiveCrop(c, m));
  if (crop) pre.push(crop);
  if (c.speed !== 1) pre.push(`setpts=PTS/${n(c.speed)}`);
  // плавное замедление: недостающие кадры дорисовываются по движению (долго, но без рывков)
  if (c.smooth && c.speed < 1 && m.kind === 'video') pre.push(`minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`);
  pre.push(`fps=${fps}`);
  if (c.color.lut) pre.push(`lut3d=file=${ffPath(c.color.lut)}:interp=tetrahedral`);
  const wheels = wheelsFilter(c.color.wheels);
  if (wheels) pre.push(wheels);
  const color = colorFilters(c);
  const f: string[] = [];
  const base = baseLayerSize(croppedMedia(m, c), c.fit, W, H);
  const mask = maskFilter(c.mask);
  // положение, размер, поворот и прозрачность — по ключевым кадрам (или от начала к концу клипа)
  const keys = keysOf(c);
  const k0 = keys[0];
  const scaleStatic = isStatic(keys, 'scale');
  const smax = range(keys, 'scale').max;
  const path = c.path && c.path.length ? c.path : null;
  const centered = isStatic(keys, 'x') && isStatic(keys, 'y') && k0.x === 0.5 && k0.y === 0.5;
  const rotates = keys.some(k => k.rotation);
  // Для «заполнить» обрезаем лишнее за пределами кадра только когда масштаб не анимируется и слой стоит по центру
  // у фигурной маски форма считается по всему слою, поэтому лишнее за кадром не срезаем
  const fillCrop = c.fit === 'fill' && scaleStatic && !path && !mask;
  if (scaleStatic) {
    f.push(`scale=${even(base.w * k0.scale)}:${even(base.h * k0.scale)}`);
    if (fillCrop && centered && !rotates) {
      f.push(`crop=${even(Math.min(base.w * k0.scale, W * Math.max(1, k0.scale)))}:${even(Math.min(base.h * k0.scale, H * Math.max(1, k0.scale)))}`);
    }
    f.push('format=yuva420p');
    if (mask) f.push(mask);
  } else {
    // форму вырезаем до изменения размера: у кадра ещё постоянный размер
    if (mask) f.push(`scale=${even(base.w)}:${even(base.h)}`, 'format=yuva420p', mask);
    // масштаб меняется во времени: t внутри scale — локальное время слоя
    const s = keyExpr(keys, 'scale', 't');
    f.push(`scale=w='2*trunc(${n(base.w)}*${s}/2)':h='2*trunc(${n(base.h)}*${s}/2)':eval=frame`);
    f.push('format=yuva420p');
  }
  if (!scaleStatic) {
    // Размер кадра меняется каждый кадр, а поворот, затухание и прозрачность в новых FFmpeg
    // так не умеют. Кладём слой на прозрачный холст постоянного размера по центру.
    const pw = Math.max(2, Math.ceil((base.w * smax) / 2) * 2), ph = Math.max(2, Math.ceil((base.h * smax) / 2) * 2);
    f.push(`pad=w=${pw}:h=${ph}:x='(ow-iw)/2':y='(oh-ih)/2':color=black@0:eval=frame`);
  }
  if (rotates) {
    const diag = even(Math.hypot(base.w * smax, base.h * smax));
    f.push(`rotate=a='${keyExpr(keys, 'rotation', 't', v => (v * Math.PI) / 180)}':ow=${diag}:oh=${diag}:c=none`);
  }
  if (isStatic(keys, 'opacity')) {
    if (k0.opacity < 1) f.push(`colorchannelmixer=aa=${n(k0.opacity, 3)}`);
  } else {
    // прозрачность меняется во времени: умножаем альфу на формулу от времени слоя
    f.push(`geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='alpha(X,Y)*clip(${keyExpr(keys, 'opacity', 'T')},0,1)'`);
  }
  if (c.fadeIn > 0) f.push(`fade=t=in:st=0:d=${n(Math.min(c.fadeIn, dur))}:alpha=1`);
  if (c.fadeOut > 0) f.push(`fade=t=out:st=${n(Math.max(0, dur - c.fadeOut))}:d=${n(Math.min(c.fadeOut, dur))}:alpha=1`);
  const T = `(t-${n(tOrigin)})`;
  const px = path ? pathExpr(path.map(p => ({ t: p.t, v: p.x })), T) : keyExpr(keys, 'x', T);
  const py = path ? pathExpr(path.map(p => ({ t: p.t, v: p.y })), T) : keyExpr(keys, 'y', T);
  const x = `'${px}*W-w/2'`;
  const y = `'${py}*H-h/2'`;
  // Собирает граф слоя: из входа src в выход out; suffix — фильтры после основной цепочки
  const emit = (graph: string[], src: string, out: string, uniq: string, suffix: string[] = []) => {
    const tail = [...f, ...suffix].join(',');
    if (faceInput !== undefined && c.faces && m.kind === 'video') {
      // размытие лиц: размытая копия кадра проступает только там, где на маске белые пятна лиц
      const mw = even(m.width || W), mh = even(m.height || H);
      const r = faceBlurRadius(c.faces, { width: mw, height: mh });
      const u = `${uniq}f`;
      graph.push(`[${src}]setpts=PTS-STARTPTS,scale=${mw}:${mh},format=yuv420p,split[${u}1][${u}2]`);
      graph.push(`[${u}2]boxblur=luma_radius=${r}:luma_power=2:chroma_radius=${Math.max(1, Math.floor(r / 2))}:chroma_power=2[${u}b]`);
      graph.push(`[${faceInput}:v]format=gray,scale=${mw}:${mh},setpts=PTS-STARTPTS[${u}m]`);
      graph.push(`[${u}b][${u}m]alphamerge[${u}a]`);
      graph.push(`[${u}1][${u}a]overlay=eof_action=repeat[${u}s]`);
      src = `${u}s`;
    }
    if (!c.key) {
      graph.push(`[${src}]${[...pre, ...color, tail].join(',')}[${out}]`);
      return;
    }
    const s1 = `${uniq}k1`, s2 = `${uniq}k2`, ka = `${uniq}ka`, kc = `${uniq}kc`;
    const key = `colorkey=${hex(c.key.color)}:${n(Math.max(0.01, Math.min(1, c.key.similarity)), 3)}:${n(Math.max(0, Math.min(1, c.key.blend)), 3)}`;
    graph.push(`[${src}]${pre.join(',')},split[${s1}][${s2}]`);
    graph.push(`[${s1}]format=rgba,${key},alphaextract[${ka}]`);
    graph.push(`[${s2}]${[...color, 'format=yuv420p'].join(',')}[${kc}]`);
    graph.push(`[${kc}][${ka}]alphamerge,${tail}[${out}]`);
  };
  return { emit, x, y, dur };
}

// Обработка голоса: шумоподавление и «голос как в студии» (срез гула, разборчивость, ровная громкость)
export function voiceFilters(c: Pick<MediaClip, 'denoise' | 'voice' | 'eq'>): string[] {
  const f: string[] = [];
  const d = Math.max(0, Math.min(1, c.denoise || 0));
  if (d > 0) f.push(`afftdn=nr=${Math.round(6 + d * 24)}:nf=-${Math.round(50 - d * 12)}:tn=1`);
  if (c.voice) {
    f.push('highpass=f=80', 'equalizer=f=250:t=q:w=1:g=-2', 'equalizer=f=3500:t=q:w=1.2:g=3', 'equalizer=f=9000:t=q:w=1:g=1.5');
    f.push('acompressor=threshold=-20dB:ratio=3:attack=8:release=160:makeup=2');
  }
  f.push(...eqFilters(c.eq));
  return f;
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
  const x = `'(W-w)/2${dx.join('')}${followX(c)}'`;
  const y = `'(H-h)/2${dy.join('')}${followY(c)}'`;
  return { filters: f, x, y };
}

// Текст едет за объектом: сдвиг по рассчитанному пути (время — от начала текста)
const followX = (c: TextClip) => (c.follow && c.path?.length ? `+(${pathExpr(c.path.map(q => ({ t: q.t, v: q.x })), `(t-${n(c.start)})`)})*W` : '');
const followY = (c: TextClip) => (c.follow && c.path?.length ? `+(${pathExpr(c.path.map(q => ({ t: q.t, v: q.y })), `(t-${n(c.start)})`)})*H` : '');

export function buildExportArgs(
  projectIn: Project,
  texts: TextRender[],
  opts: ExportOptions,
  extras: ExportExtras = {},
): ExportPlan {
  const p: Project = JSON.parse(JSON.stringify(projectIn));
  layoutProject(p);
  resolveFollows(p);
  const W = even(p.width), H = even(p.height), fps = p.fps;
  const total = Math.max(0.5, projectDuration(p));
  const mediaMap = new Map(p.media.map(m => [m.id, m]));
  const textMap = new Map<string, TextRender[]>();
  for (const t of texts) textMap.set(t.clipId, [...(textMap.get(t.clipId) || []), t]);
  const files: ExportPlan['files'] = [];

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
    // видео с прозрачным фоном: альфа-канал VP9 читает только декодер libvpx
    return addInput([...(m.alpha ? ['-c:v', 'libvpx-vp9'] : []), '-ss', n(c.in), '-t', n(len), '-i', m.path]);
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
  // Маска лиц: лента чёрно-белых картинок по времени исходника (белое — где размыть)
  const faceInput = (c: MediaClip): number | undefined => {
    const renders = textMap.get('faces:' + c.id);
    if (!c.faces || !renders?.length || !extras.tempDir) return undefined;
    const q = (f: string) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
    const lines = ['ffconcat version 1.0'];
    const sorted = [...renders].sort((a, b) => (a.from ?? 0) - (b.from ?? 0));
    for (const r of sorted) lines.push(q(r.path), `duration ${n(Math.max(0.01, (r.to ?? 0) - (r.from ?? 0)))}`);
    lines.push(q(sorted[sorted.length - 1].path));
    const list = `${extras.tempDir.replace(/[\\/]+$/, '')}/${c.id}_faces.ffconcat`;
    files.push({ path: list, content: lines.join('\n') + '\n' });
    return addInput(['-f', 'concat', '-safe', '0', '-i', list]);
  };

  let vAcc = '';
  if (!audioOnly) {
    if (mainClips.length && !mainTrack.hidden) {
      let accEnd = 0;
      mainClips.forEach((c, i) => {
        const m = mediaMap.get(c.mediaId)!;
        if (m.kind === 'audio') return;
        const idx = ensureInput(c);
        const { emit, x, y, dur } = layerChain(c, m, W, H, fps, 0, faceInput(c));
        const lay = L('l'), bgl = L('b'), out = L('m');
        emit(graph, `${idx}:v`, lay, L('q'));
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
    const overlayText = (png: string, c: TextClip, from: number, to: number, animated: boolean) => {
      const idx = addInput(['-loop', '1', '-framerate', String(fps), '-t', n(to - from), '-i', png]);
      const { filters, x, y } = animated ? textOverlay(c) : { filters: ['format=rgba'], x: `'(W-w)/2${followX(c)}'`, y: `'(H-h)/2${followY(c)}'` };
      const st = c.start + from;
      const lay = L('l'), nx = L('s');
      graph.push(`[${idx}:v]${filters.join(',')},setpts=PTS+${n(st)}/TB[${lay}]`);
      graph.push(`[${vAcc}][${lay}]overlay=x=${x}:y=${y}:eval=frame:eof_action=pass:enable='between(t,${n(st)},${n(c.start + to)})'[${nx}]`);
      vAcc = nx;
    };
    for (const track of p.tracks) {
      if (track.kind === 'main' || track.kind === 'audio' || track.hidden) continue;
      // Текст без анимаций (субтитры, «слово за словом») идёт одной лентой картинок:
      // один вход FFmpeg на всю дорожку вместо сотен, так быстрее и надёжнее на длинных роликах.
      const seq: { path: string; start: number; end: number }[] = [];
      const inSeq = new Set<string>();
      if (extras.tempDir && extras.blank) {
        const cand = track.clips
          .filter((c): c is TextClip => c.type === 'text' && c.animIn === 'none' && c.animOut === 'none' && !c.follow && !!textMap.get(c.id))
          .sort((a, b) => a.start - b.start);
        let lastEnd = 0;
        for (const c of cand) {
          if (c.start < lastEnd - 1e-3) continue;
          const renders = [...textMap.get(c.id)!].sort((a, b) => (a.from ?? 0) - (b.from ?? 0));
          for (const r of renders) {
            const st = c.start + Math.max(0, r.from ?? 0), en = c.start + Math.min(c.duration, r.to ?? c.duration);
            if (en - st > 1e-3) seq.push({ path: r.path, start: st, end: en });
          }
          lastEnd = c.start + c.duration;
          inSeq.add(c.id);
        }
        if (seq.length < 2) { seq.length = 0; inSeq.clear(); }
      }
      if (seq.length) {
        const q = (f: string) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
        const lines = ['ffconcat version 1.0'];
        let t = 0;
        for (const it of seq) {
          if (it.start - t > 1e-3) lines.push(q(extras.blank!), `duration ${n(it.start - t)}`);
          lines.push(q(it.path), `duration ${n(it.end - Math.max(t, it.start))}`);
          t = it.end;
        }
        lines.push(q(extras.blank!), 'duration 0.1', q(extras.blank!));
        const list = `${extras.tempDir!.replace(/[\\/]+$/, '')}/${track.id}_subs.ffconcat`;
        files.push({ path: list, content: lines.join('\n') + '\n' });
        const idx = addInput(['-f', 'concat', '-safe', '0', '-i', list]);
        const lay = L('l'), nx = L('s');
        graph.push(`[${idx}:v]format=rgba,setpts=PTS-STARTPTS[${lay}]`);
        graph.push(`[${vAcc}][${lay}]overlay=x=0:y=0:eof_action=pass:repeatlast=0[${nx}]`);
        vAcc = nx;
      }
      for (const c of track.clips) {
        if (c.type === 'media') {
          const m = mediaMap.get(c.mediaId);
          if (!m || m.kind === 'audio') continue;
          const dur = clipDuration(c);
          const on = `enable='between(t,${n(c.start)},${n(c.start + dur)})'`;
          if (c.adjust) {
            // Корректирующий слой: своей картинки нет, цвет и эффекты применяются ко всему, что под ним
            const a1 = L('j'), a2 = L('j'), a3 = L('j'), nx = L('s');
            const op = keysOf(c)[0].opacity;
            const fl = [
              ...(c.color.lut ? [`lut3d=file=${ffPath(c.color.lut)}:interp=tetrahedral`] : []),
              ...(wheelsFilter(c.color.wheels) ? [wheelsFilter(c.color.wheels)] : []),
              ...colorFilters(c), 'format=yuva420p',
            ];
            if (op < 1) fl.push(`colorchannelmixer=aa=${n(Math.max(0, op), 3)}`);
            if (c.fadeIn > 0) fl.push(`fade=t=in:st=${n(c.start)}:d=${n(Math.min(c.fadeIn, dur))}:alpha=1`);
            if (c.fadeOut > 0) fl.push(`fade=t=out:st=${n(c.start + Math.max(0, dur - c.fadeOut))}:d=${n(Math.min(c.fadeOut, dur))}:alpha=1`);
            graph.push(`[${vAcc}]split[${a1}][${a2}]`);
            graph.push(`[${a2}]${fl.join(',')}[${a3}]`);
            graph.push(`[${a1}][${a3}]overlay=x=0:y=0:${on}[${nx}]`);
            vAcc = nx;
            continue;
          }
          const idx = ensureInput(c);
          const { emit, x, y } = layerChain(c, m, W, H, fps, c.start, faceInput(c));
          const lay = L('l'), nx = L('s');
          emit(graph, `${idx}:v`, lay, L('q'), [`setpts=PTS+${n(c.start)}/TB`]);
          const bm = blendOf(c.blend);
          if (bm.ff) {
            // Режим наложения: слой кладём на прозрачный холст размером с кадр, смешиваем с картинкой под ним
            // и оставляем результат только там, где слой непрозрачен
            const cv = L('j'), full = L('j'), fa = L('j'), fb = L('j'), ma = L('j'), v1 = L('j'), v2 = L('j'), g1 = L('j'), g2 = L('j'), bl = L('j'), ba = L('j');
            graph.push(`color=c=black@0:s=${W}x${H}:r=${fps}:d=${n(total)},format=yuva420p[${cv}]`);
            graph.push(`[${cv}][${lay}]overlay=x=${x}:y=${y}:eval=frame:eof_action=pass:format=auto:${on}[${full}]`);
            graph.push(`[${full}]split[${fa}][${fb}]`);
            graph.push(`[${fa}]alphaextract[${ma}]`);
            graph.push(`[${vAcc}]split[${v1}][${v2}]`);
            graph.push(`[${v2}]format=gbrp[${g1}]`);
            graph.push(`[${fb}]format=gbrp[${g2}]`);
            graph.push(`${bm.swap ? `[${g1}][${g2}]` : `[${g2}][${g1}]`}blend=all_mode=${bm.ff},format=yuv420p[${bl}]`);
            graph.push(`[${bl}][${ma}]alphamerge[${ba}]`);
            graph.push(`[${v1}][${ba}]overlay=x=0:y=0[${nx}]`);
          } else {
            graph.push(`[${vAcc}][${lay}]overlay=x=${x}:y=${y}:eval=frame:eof_action=pass:${on}[${nx}]`);
          }
          vAcc = nx;
        } else if (c.type === 'text' && !inSeq.has(c.id)) {
          const renders = textMap.get(c.id);
          if (!renders) continue;
          const multi = renders.length > 1 || renders[0].from !== undefined;
          for (const r of renders) {
            const from = Math.max(0, r.from ?? 0), to = Math.min(c.duration, r.to ?? c.duration);
            if (to - from > 1e-3) overlayText(r.path, c, from, to, !multi);
          }
        }
      }
    }
  }

  // ── Звук ──────────────────────────────────────────────
  for (const track of p.tracks) {
    if (track.muted || (track.volume ?? 1) <= 0) continue;
    const clips = track.clips;
    clips.forEach((c, i) => {
      if (c.type !== 'media' || c.muted || c.volume <= 0 || c.adjust) return;
      const m = mediaMap.get(c.mediaId);
      // мультикамера: звук может идти с другой камеры, но с того же момента съёмки
      const cam = camAudioSource(p, c);
      if (!cam && (!m || !m.hasAudio || m.kind === 'image')) return;
      const idx = cam ? addInput(['-ss', n(cam.in), '-t', n(Math.max(0.05, cam.out - cam.in)), '-i', cam.media.path]) : ensureInput(c);
      const dur = clipDuration(c);
      const f: string[] = ['asetpts=PTS-STARTPTS', 'aresample=48000', 'aformat=channel_layouts=stereo', ...atempoChain(c.speed), ...voiceFilters(c)];
      const vol = c.volume * (track.volume ?? 1);
      if (vol !== 1) f.push(`volume=${n(vol, 3)}`);
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
      // все дорожки дотягиваем тишиной до конца ролика: тогда amix и приглушение музыки
      // не зависят от того, какая дорожка закончилась раньше (в новых FFmpeg звук иногда обрывался)
      f.push(`apad=whole_dur=${n(total)}`);
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
  // Выравнивание громкости под площадки (EBU R128) или просто защита от перегруза
  const level = opts.loudness ? `loudnorm=I=${n(Math.max(-30, Math.min(-8, opts.loudness)), 1)}:TP=-1.5:LRA=11,aresample=48000` : 'alimiter=limit=0.97';
  graph.push(`[${aAcc}]apad=whole_dur=${n(total)},atrim=duration=${n(total)},${level}[${aFinal}]`);
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
  return { args, duration: outDur, files };
}
