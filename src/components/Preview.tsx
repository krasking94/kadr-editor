// Окно просмотра: собирает кадр из всех дорожек в реальном времени и проигрывает проект.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Camera, ChevronFirst, ChevronLast, Expand, Grid3x3, Pause, Play, SkipBack, SkipForward, Upload, Volume2, VolumeX } from 'lucide-react';
import { api, mediaUrl } from '../api';
import type { MediaClip, MediaItem, Project, TextClip, Track } from '../../shared/types';
import { baseLayerSize } from '../../shared/export-graph';
import { clipDuration, cssFilter, formatTime, projectDuration, textAnimState, transformAt, transitionDuration, FORMAT_PRESETS } from '../../shared/timeline';
import { drawText } from '../lib/text-render';
import { loadFonts } from '../lib/fonts';
import { set, sourceLabel, toast, useStore } from '../state/store';
import { applyFormatPreset, importFiles, renderFrame, updateMediaClip, updateTextClip } from '../state/actions';
import { openMenu } from './ui';
import { NO_FX, transitionFx, type TransitionFx } from '../lib/transition-fx';

const GRAIN = `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='0.9'/></svg>")`;

interface LayerInfo {
  clip: MediaClip | TextClip;
  track: Track;
  visible: boolean;
  z: number;
  fx: TransitionFx;
}

function collectLayers(p: Project, t: number, W: number, H: number): { layers: LayerInfo[]; flash: { color: string; opacity: number } | null } {
  const layers: LayerInfo[] = [];
  let flash: { color: string; opacity: number } | null = null;
  let z = 0;
  for (const track of p.tracks) {
    if (track.hidden && track.kind !== 'audio') { z += 100; continue; }
    track.clips.forEach((c, i) => {
      const end = c.start + clipDuration(c);
      const preload = c.type === 'media' && t >= c.start - 1.5 && t < c.start;
      const visible = t >= c.start && t < end;
      if (!visible && !preload) return;
      let fx = NO_FX;
      if (track.kind === 'main' && c.type === 'media') {
        const prev = track.clips[i - 1];
        const td = transitionDuration(prev, c);
        if (td > 0 && c.transition && t < c.start + td) fx = transitionFx(c.transition.type, (t - c.start) / td, true, W, H);
        const next = track.clips[i + 1];
        if (next && next.type === 'media' && next.transition) {
          const ntd = transitionDuration(c, next);
          if (ntd > 0 && t >= next.start && t < next.start + ntd) {
            const pr = (t - next.start) / ntd;
            fx = transitionFx(next.transition.type, pr, false, W, H);
            if (next.transition.type === 'fadewhite') flash = { color: '#fff', opacity: 1 - Math.abs(2 * pr - 1) };
          }
        }
      }
      layers.push({ clip: c, track, visible, z: z + i, fx });
    });
    z += 100;
  }
  return { layers, flash };
}

export function Preview() {
  const project = useStore(s => s.project)!;
  const playhead = useStore(s => s.playhead);
  const playing = useStore(s => s.playing);
  const selection = useStore(s => s.selection);
  const safeZones = useStore(s => s.safeZones);
  const lastAction = useStore(s => s.lastAction);
  const [box, setBox] = useState({ w: 800, h: 450 });
  const [muted, setMuted] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const duration = projectDuration(project);

  useLayoutEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth - 32, h: el.clientHeight - 32 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Часы проигрывания
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const startNow = performance.now();
    const startT = useStore.getState().playhead >= duration - 0.05 ? 0 : useStore.getState().playhead;
    const tick = () => {
      const t = startT + (performance.now() - startNow) / 1000;
      const dur = projectDuration(useStore.getState().project!);
      if (t >= dur) { set({ playhead: dur, playing: false }); return; }
      set({ playhead: t });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const aspect = project.width / project.height;
  const stageW = Math.max(50, Math.min(box.w, box.h * aspect));
  const stageH = stageW / aspect;
  const k = stageW / project.width;
  const { layers, flash } = useMemo(() => collectLayers(project, playhead, stageW, stageH), [project, playhead, stageW, stageH]);
  const mediaMap = useMemo(() => new Map(project.media.map(m => [m.id, m])), [project.media]);
  const empty = !project.tracks.some(t => t.clips.length);
  const aiRecent = lastAction && lastAction.source !== 'user' && Date.now() - lastAction.at < 2500;
  const [, force] = useState(0);
  useEffect(() => { if (aiRecent) { const t = setTimeout(() => force(x => x + 1), 2600); return () => clearTimeout(t); } }, [lastAction]);

  const step = (d: number) => set(s => ({ playhead: Math.max(0, Math.min(duration, s.playhead + d)), playing: false }));
  const fmt = FORMAT_PRESETS.find(f => f.width === project.width && f.height === project.height);

  const snapshot = async () => {
    try {
      const b64 = await renderFrame(playhead, project.width);
      const path = await api.saveImage('data:image/jpeg;base64,' + b64, `${project.name} ${formatTime(playhead).replace(/:/g, '-')}`);
      toast('success', 'Кадр сохранён как картинка', { detail: path, action: { label: 'Показать', run: () => api.showItem(path) } });
    } catch (e) {
      toast('error', 'Не удалось сохранить кадр', { detail: String(e) });
    }
  };

  useEffect(() => {
    const h = () => snapshot();
    window.addEventListener('kadr:snapshot', h);
    return () => window.removeEventListener('kadr:snapshot', h);
  });

  return (
    <div className="preview">
      <div className="stage-wrap" ref={wrapRef}
        onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
        onDrop={e => {
          const files = [...e.dataTransfer.files].map(f => api.pathForFile(f)).filter(Boolean);
          if (files.length) { e.preventDefault(); e.stopPropagation(); importFiles(files, { toTimeline: true }); }
        }}>
        {aiRecent && <div className="ai-banner"><span className="pulse-dot" /> {sourceLabel(lastAction!.source)}: {lastAction!.label}</div>}
        <div className="stage" ref={stageRef} style={{ width: stageW, height: stageH, background: project.background }}
          onMouseDown={e => { if (e.target === e.currentTarget) set({ selection: [] }); }}>
          {layers.map(l => l.clip.type === 'media'
            ? <MediaLayer key={l.clip.id} info={l} media={mediaMap.get(l.clip.mediaId)} W={stageW} H={stageH} k={k}
              t={playhead} playing={playing} selected={selection.includes(l.clip.id)} muted={muted} />
            : <TextLayer key={l.clip.id} clip={l.clip} z={l.z} W={stageW} H={stageH} t={playhead} selected={selection.includes(l.clip.id)} />)}
          {flash && <div style={{ position: 'absolute', inset: 0, background: flash.color, opacity: flash.opacity, zIndex: 50, pointerEvents: 'none' }} />}
          {safeZones && <div className="safe-zones" style={{ zIndex: 9999 }}><Thirds /></div>}
        </div>
        {empty && (
          <div className="preview-empty">
            <div>
              <div className="big-icon"><Upload size={28} /></div>
              <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>Перетащите сюда видео, фото или музыку</div>
              <div style={{ marginTop: 6 }}>или нажмите <b>«Добавить файлы»</b> слева. Можно попросить ИИ-помощника справа.</div>
            </div>
          </div>
        )}
      </div>
      <div className="transport">
        <button className="icon-btn" data-tip={'В начало\nHome'} onClick={() => set({ playhead: 0, playing: false })}><ChevronFirst size={18} /></button>
        <button className="icon-btn" data-tip={'Кадр назад\n←'} onClick={() => step(-1 / project.fps)}><SkipBack size={16} /></button>
        <button className="play-btn" data-tip={playing ? 'Пауза\nПробел' : 'Смотреть\nПробел'} onClick={() => set(s => ({ playing: !s.playing }))}>
          {playing ? <Pause size={18} fill="#fff" /> : <Play size={18} fill="#fff" style={{ marginLeft: 2 }} />}
        </button>
        <button className="icon-btn" data-tip={'Кадр вперёд\n→'} onClick={() => step(1 / project.fps)}><SkipForward size={16} /></button>
        <button className="icon-btn" data-tip={'В конец\nEnd'} onClick={() => set({ playhead: duration, playing: false })}><ChevronLast size={18} /></button>
        <div className="timecode" data-tip="Текущее время / длина ролика">
          {formatTime(playhead, project.fps, true)} <span className="total">/ {formatTime(duration, project.fps, true)}</span>
        </div>
        <div className="spacer" />
        <button className="badge accent" style={{ cursor: 'pointer' }} data-tip="Формат кадра. Нажмите, чтобы поменять"
          onClick={e => openMenu([{ header: 'Формат видео' }, ...FORMAT_PRESETS.map(f => ({ label: `${f.label} · ${f.hint}`, onClick: () => applyFormatPreset(f.id) }))], e.clientX, e.clientY)}>
          {fmt ? fmt.label : `${project.width}×${project.height}`}
        </button>
        <button className="icon-btn" data-tip={muted ? 'Включить звук' : 'Выключить звук в просмотре'} onClick={() => setMuted(!muted)}>{muted ? <VolumeX size={16} /> : <Volume2 size={16} />}</button>
        <button className={'icon-btn' + (safeZones ? ' active' : '')} data-tip={'Сетка и безопасные зоны\nчтобы текст не обрезался в соцсетях'} onClick={() => set(s => ({ safeZones: !s.safeZones }))}><Grid3x3 size={16} /></button>
        <button className="icon-btn" data-tip="Сохранить этот кадр как картинку" onClick={snapshot}><Camera size={16} /></button>
        <button className="icon-btn" data-tip={'Во весь экран\nF'} onClick={() => stageRef.current?.parentElement?.requestFullscreen()}><Expand size={16} /></button>
      </div>
    </div>
  );
}

function Thirds() {
  return (
    <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0 }}>
      {[1, 2].map(i => <line key={'v' + i} x1={`${i * 33.333}%`} x2={`${i * 33.333}%`} y1="0" y2="100%" stroke="rgba(255,255,255,.22)" />)}
      {[1, 2].map(i => <line key={'h' + i} y1={`${i * 33.333}%`} y2={`${i * 33.333}%`} x1="0" x2="100%" stroke="rgba(255,255,255,.22)" />)}
    </svg>
  );
}

const MediaLayer = memo(function MediaLayer(p: { info: LayerInfo; media?: MediaItem; W: number; H: number; k: number; t: number; playing: boolean; selected: boolean; muted: boolean }) {
  const c = p.info.clip as MediaClip;
  const m = p.media;
  const elRef = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const local = Math.max(0, p.t - c.start);
  const desired = c.in + local * c.speed;
  const visible = p.info.visible;
  const dur = clipDuration(c);

  // Синхронизация видео/звука с общим временем
  useEffect(() => {
    const el = elRef.current;
    if (!el || !m || m.kind === 'image') return;
    const target = visible ? desired : c.in;
    if (p.playing && visible) {
      if (Math.abs(el.playbackRate - c.speed) > 0.001) el.playbackRate = Math.max(0.0625, Math.min(16, c.speed));
      if (Math.abs(el.currentTime - target) > 0.25) el.currentTime = target;
      if (el.paused) el.play().catch(() => undefined);
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - target) > 0.02) el.currentTime = target;
    }
    let gain = c.volume;
    if (c.audioFadeIn > 0 && local < c.audioFadeIn) gain *= local / c.audioFadeIn;
    if (c.audioFadeOut > 0 && dur - local < c.audioFadeOut) gain *= Math.max(0, (dur - local) / c.audioFadeOut);
    gain *= p.info.fx.opacity;
    el.volume = Math.max(0, Math.min(1, gain));
    el.muted = p.muted || c.muted || p.info.track.muted || !visible;
  });

  if (!m || m.missing) {
    if (!visible || p.info.track.kind === 'audio') return null;
    return <div className="layer" style={{ width: p.W, height: p.H, zIndex: p.info.z, display: 'grid', placeItems: 'center', background: '#3a1620', color: '#ffb3bd', fontSize: 13 }}>Файл не найден: {m?.name}</div>;
  }
  if (m.kind === 'audio' || p.info.track.hidden) {
    return <audio ref={elRef} src={mediaUrl(m.path)} preload="auto" />;
  }
  const tr = transformAt(c, local);
  const base = baseLayerSize(m, c.fit, p.W, p.H);
  const w = base.w * tr.scale, h = base.h * tr.scale;
  const fx = p.info.fx;
  let opacity = tr.opacity * fx.opacity;
  if (c.fadeIn > 0 && local < c.fadeIn) opacity *= local / c.fadeIn;
  if (c.fadeOut > 0 && dur - local < c.fadeOut) opacity *= Math.max(0, (dur - local) / c.fadeOut);
  const flip = `${c.effects.flipH ? ' scaleX(-1)' : ''}${c.effects.flipV ? ' scaleY(-1)' : ''}`;
  const style: CSSProperties = {
    width: w, height: h, zIndex: p.info.z,
    transform: `translate(${tr.x * p.W - w / 2 + fx.dx}px, ${tr.y * p.H - h / 2 + fx.dy}px) rotate(${tr.rotation}deg) scale(${fx.scale})`,
    opacity: visible ? opacity : 0, filter: cssFilter(c, p.k) || undefined,
    clipPath: fx.clip, WebkitMaskImage: fx.mask, maskImage: fx.mask,
    visibility: visible ? 'visible' : 'hidden', cursor: visible ? 'move' : undefined,
  };
  const inner: CSSProperties = flip ? { transform: flip.trim(), width: '100%', height: '100%' } : { width: '100%', height: '100%' };
  return (
    <div className={'layer' + (p.selected && visible ? ' selected' : '')} style={style} onPointerDown={e => startLayerDrag(e, c, p.W, p.H)}>
      <div style={inner}>
        {m.kind === 'image'
          ? <img src={mediaUrl(m.path)} draggable={false} />
          : <video ref={elRef} src={mediaUrl(m.path)} preload="auto" playsInline disablePictureInPicture />}
      </div>
      {c.effects.vignette > 0 && <div className="vignette" style={{ background: `radial-gradient(ellipse at center, transparent ${60 - c.effects.vignette * 35}%, rgba(0,0,0,${0.35 + c.effects.vignette * 0.6}) 100%)` }} />}
      {c.effects.grain > 0 && <div className="grain" style={{ backgroundImage: GRAIN, opacity: c.effects.grain * 0.8 }} />}
    </div>
  );
});

// Перетаскивание слоя мышью прямо в кадре
function startLayerDrag(e: React.PointerEvent, c: MediaClip, W: number, H: number) {
  if (e.button !== 0) return;
  e.stopPropagation();
  const s = useStore.getState();
  if (!s.selection.includes(c.id)) set({ selection: [c.id] });
  const startX = e.clientX, startY = e.clientY;
  const t0 = { ...c.transform };
  const te0 = { ...c.transformEnd };
  let moved = false;
  const move = (ev: PointerEvent) => {
    const dx = (ev.clientX - startX) / W, dy = (ev.clientY - startY) / H;
    if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 3) return;
    moved = true;
    let nx = t0.x + dx, ny = t0.y + dy;
    // прилипание к центру
    if (Math.abs(nx - 0.5) < 0.012) nx = 0.5;
    if (Math.abs(ny - 0.5) < 0.012) ny = 0.5;
    updateMediaClip(c.id, {
      transform: { x: nx, y: ny },
      ...(c.animate ? { transformEnd: { x: te0.x + (nx - t0.x), y: te0.y + (ny - t0.y) } } : {}),
    }, 'Положение изменено', { coalesce: 'drag:' + c.id });
  };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

const TextLayer = memo(function TextLayer(p: { clip: TextClip; z: number; W: number; H: number; t: number; selected: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [bbox, setBbox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [fontsReady, setFontsReady] = useState(false);
  useEffect(() => { loadFonts().then(() => setFontsReady(true)); }, []);
  const styleKey = JSON.stringify([p.clip.text, p.clip.style, p.W, p.H, fontsReady]);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(p.W * dpr);
    cv.height = Math.round(p.H * dpr);
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, p.W, p.H);
    setBbox(drawText(ctx, p.clip, p.W, p.H));
  }, [styleKey]);
  const visible = p.t >= p.clip.start && p.t < p.clip.start + p.clip.duration;
  const a = textAnimState(p.clip, p.t - p.clip.start);
  const tf = `translate(${a.dx * p.W}px, ${a.dy * p.H}px) scale(${a.scale})`;
  return (
    <>
      <canvas ref={ref} className="text-canvas" style={{ width: p.W, height: p.H, zIndex: p.z, opacity: visible ? a.opacity : 0, transform: tf, transformOrigin: `${p.clip.style.x * 100}% ${p.clip.style.y * 100}%` }} />
      {visible && bbox && (
        <div style={{ position: 'absolute', left: bbox.x, top: bbox.y, width: bbox.w, height: bbox.h, zIndex: p.z + 1, cursor: 'move', outline: p.selected ? '2px solid var(--accent)' : undefined, outlineOffset: 4, borderRadius: 3 }}
          onPointerDown={e => startTextDrag(e, p.clip, p.W, p.H)}
          onDoubleClick={() => set({ selection: [p.clip.id], inspectorTab: 'text' })} />
      )}
    </>
  );
});

function startTextDrag(e: React.PointerEvent, c: TextClip, W: number, H: number) {
  if (e.button !== 0) return;
  e.stopPropagation();
  set({ selection: [c.id] });
  const sx = e.clientX, sy = e.clientY;
  const x0 = c.style.x, y0 = c.style.y;
  const move = (ev: PointerEvent) => {
    let nx = x0 + (ev.clientX - sx) / W, ny = y0 + (ev.clientY - sy) / H;
    if (Math.abs(nx - 0.5) < 0.012) nx = 0.5;
    if (Math.abs(ny - 0.5) < 0.012) ny = 0.5;
    updateTextClip(c.id, { style: { x: Math.max(0, Math.min(1, nx)), y: Math.max(0, Math.min(1, ny)) } }, 'Текст передвинут', { coalesce: 'drag:' + c.id });
  };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

