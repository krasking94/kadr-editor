// Таймлайн: дорожки с клипами. Перетаскивание, подрезка краёв, ножницы, прилипание, переходы, метки.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AudioLines, Blend, Bookmark, Copy, CopyPlus, Eye, EyeOff, Film, Gauge, Image as ImageIcon, Layers, Lock, LockOpen, Magnet, Maximize2,
  MousePointer2, Move, Music, Plus, Scissors, Snowflake, SquareSplitHorizontal, Trash2, Type, Volume2, VolumeX, ZoomIn, ZoomOut,
} from 'lucide-react';
import { api } from '../api';
import type { Clip, MediaClip, MediaItem, TextClip, Track, TrackKind, TransitionType } from '../../shared/types';
import { clipDuration, clipEnd, COLOR_PRESETS, formatTime, MIN_CLIP, projectDuration, TRANSITIONS, transitionDuration } from '../../shared/timeline';
import { commit, get, set, toast, useStore, type MediaCacheEntry } from '../state/store';
import * as A from '../state/actions';
import { saveLayout, saveSettings } from '../state/settings-actions';
import { DND_MEDIA, DND_TEXT } from '../lib/dnd';
import { presetById } from '../lib/text-presets';
import { commandById } from '../lib/commands';
import { openMenu, type MenuItem } from './ui';

const RULER_H = 28;
const TRACK_H: Record<TrackKind, number> = { main: 72, video: 54, text: 38, audio: 50 };
const COLORS: Record<TrackKind, string> = { main: 'var(--clip-main)', video: 'var(--clip-video)', text: 'var(--clip-text)', audio: 'var(--clip-audio)' };
const ICONS: Record<TrackKind, typeof Film> = { main: Film, video: Layers, text: Type, audio: Music };

interface Row { track: Track; top: number; h: number }

type Drag =
  | { kind: 'move'; id: string; fromTrack: string; x0: number; y0: number; origStart: number; dur: number; moved: boolean; dx: number; dy: number; target: string | null; start: number; index?: number; snap?: number }
  | { kind: 'trim'; id: string; side: 'l' | 'r'; snap?: number }
  | { kind: 'scrub' };

function niceStep(zoom: number): number {
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200];
  return steps.find(s => s * zoom >= 80) ?? 1200;
}

export function Timeline() {
  const project = useStore(s => s.project)!;
  const zoom = useStore(s => s.zoom);
  const selection = useStore(s => s.selection);
  const tool = useStore(s => s.tool);
  const flash = useStore(s => s.flash);
  const cache = useStore(s => s.mediaCache);
  const snapping = useStore(s => s.settings.snapping);
  const savedHeight = useStore(s => s.settings.layout?.timeline);
  const [height, setHeight] = useState(() => savedHeight || Math.round(Math.min(420, Math.max(250, window.innerHeight * 0.38))));
  const [scroll, setScroll] = useState({ left: 0, top: 0, width: 800 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [razorX, setRazorX] = useState<number | null>(null);
  const [dropHint, setDropHint] = useState<{ x: number; track: string | null; index?: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const duration = projectDuration(project);
  const media = useMemo(() => new Map(project.media.map(m => [m.id, m])), [project.media]);

  const rows: Row[] = useMemo(() => {
    let top = 0;
    return project.tracks.map(t => { const r = { track: t, top, h: TRACK_H[t.kind] }; top += r.h; return r; });
  }, [project.tracks]);
  const rowsH = rows.reduce((a, r) => a + r.h, 0);
  const contentW = Math.max(scroll.width, (Math.max(duration, 10) + 20) * zoom);

  const onScroll = () => {
    const el = scrollRef.current!;
    setScroll({ left: el.scrollLeft, top: el.scrollTop, width: el.clientWidth });
  };
  useLayoutEffect(() => {
    const el = scrollRef.current!;
    const ro = new ResizeObserver(onScroll);
    ro.observe(el);
    onScroll();
    return () => ro.disconnect();
  }, []);

  // Линейка со временем (рисуем только видимую часть)
  useEffect(() => {
    const cv = rulerRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const W = scroll.width, H = RULER_H;
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const cs = getComputedStyle(document.documentElement);
    const muted = cs.getPropertyValue('--muted').trim() || '#7d8093';
    const line = cs.getPropertyValue('--line-2').trim() || '#343747';
    const step = niceStep(zoom);
    const minor = step / (step >= 1 && step % 5 === 0 ? 5 : 2);
    const t0 = Math.floor(scroll.left / zoom / minor) * minor;
    const t1 = (scroll.left + W) / zoom;
    ctx.font = '10.5px "JetBrains Mono", monospace';
    ctx.textBaseline = 'top';
    for (let t = t0; t <= t1; t += minor) {
      const x = Math.round(t * zoom - scroll.left) + 0.5;
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      ctx.strokeStyle = major ? muted : line;
      ctx.beginPath(); ctx.moveTo(x, major ? 14 : 20); ctx.lineTo(x, H); ctx.stroke();
      if (major) { ctx.fillStyle = muted; ctx.fillText(step < 1 ? t.toFixed(1) + 'с' : formatTime(t), x + 4, 4); }
    }
    // конец ролика
    const ex = duration * zoom - scroll.left;
    if (ex > 0 && ex < W) { ctx.fillStyle = 'rgba(255,92,138,.5)'; ctx.fillRect(ex, 0, 2, H); }
  }, [scroll, zoom, duration]);

  // ── Перевод координат ─────────────────────────────
  const timeAt = useCallback((clientX: number) => {
    const r = contentRef.current!.getBoundingClientRect();
    return Math.max(0, (clientX - r.left) / zoom);
  }, [zoom]);
  const rowAt = (clientY: number): Row | null => {
    const r = contentRef.current!.getBoundingClientRect();
    const y = clientY - r.top - RULER_H;
    return rows.find(row => y >= row.top && y < row.top + row.h) || null;
  };
  const snapPoints = (exclude: string) => {
    const pts = [0, get().playhead, ...project.markers.map(m => m.time)];
    for (const t of project.tracks) for (const c of t.clips) if (c.id !== exclude) pts.push(c.start, clipEnd(c));
    return pts;
  };
  const snapTo = (t: number, exclude: string, alsoEnd?: number): { t: number; at?: number } => {
    if (!snapping) return { t };
    const th = 9 / zoom;
    let best: { t: number; at?: number; d: number } = { t, d: th };
    for (const p of snapPoints(exclude)) {
      if (Math.abs(p - t) < best.d) best = { t: p, at: p, d: Math.abs(p - t) };
      if (alsoEnd !== undefined && Math.abs(p - (t + alsoEnd)) < best.d) best = { t: p - alsoEnd, at: p, d: Math.abs(p - (t + alsoEnd)) };
    }
    return { t: best.t, at: best.at };
  };
  const mainIndexAt = (t: number, exclude?: string) => {
    const main = project.tracks.find(x => x.kind === 'main')!;
    return main.clips.filter(c => c.id !== exclude).filter(c => c.start + clipDuration(c) / 2 < t).length;
  };
  const indexX = (index: number, exclude?: string) => {
    const main = project.tracks.find(x => x.kind === 'main')!.clips.filter(c => c.id !== exclude);
    if (!main.length) return 0;
    return index < main.length ? main[index].start * zoom : clipEnd(main[main.length - 1]) * zoom;
  };
  const canGo = (c: Clip, m: MediaItem | undefined, t: Track) => {
    if (t.locked) return false;
    if (c.type === 'text') return t.kind === 'text';
    if (m?.kind === 'audio') return t.kind === 'audio';
    return t.kind === 'main' || t.kind === 'video';
  };

  // ── Мышь: клипы ───────────────────────────────────
  const onClipDown = (e: React.PointerEvent, c: Clip, track: Track, part: 'body' | 'l' | 'r') => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const s = get();
    if (tool === 'razor') {
      A.splitAt(timeAt(e.clientX), c.id);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      set({ selection: s.selection.includes(c.id) ? s.selection.filter(x => x !== c.id) : [...s.selection, c.id] });
      return;
    }
    if (!s.selection.includes(c.id)) set({ selection: [c.id] });
    if (track.locked) { toast('info', 'Дорожка закреплена (замок) — снимите замок, чтобы менять клипы'); return; }
    const x0 = e.clientX, y0 = e.clientY;
    const m = c.type === 'media' ? media.get(c.mediaId) : undefined;
    if (part !== 'body') {
      const orig = structuredClone(c);
      const d: Drag = { kind: 'trim', id: c.id, side: part };
      dragRef.current = d; setDrag(d);
      const move = (ev: PointerEvent) => {
        const dt = (ev.clientX - x0) / zoom;
        if (orig.type === 'text') {
          if (part === 'l') {
            const sn = snapTo(orig.start + dt, c.id);
            const ns = Math.max(0, Math.min(sn.t, orig.start + orig.duration - MIN_CLIP));
            A.trimClip(c.id, { start: ns, duration: orig.start + orig.duration - ns }, { coalesce: 'trim:' + c.id });
            setDrag({ ...d, snap: sn.at }); set({ playhead: ns });
          } else {
            const sn = snapTo(orig.start + orig.duration + dt, c.id);
            const nd = Math.max(MIN_CLIP, sn.t - orig.start);
            A.trimClip(c.id, { duration: nd }, { coalesce: 'trim:' + c.id });
            setDrag({ ...d, snap: sn.at }); set({ playhead: orig.start + nd - 0.001 });
          }
          return;
        }
        const maxOut = m?.kind === 'image' ? 3600 : m?.duration ?? orig.out;
        if (part === 'l') {
          let edge = orig.start + dt;
          const sn = track.kind === 'main' ? { t: edge, at: undefined } : snapTo(edge, c.id);
          edge = sn.t;
          const nin = Math.max(0, Math.min(orig.out - MIN_CLIP, orig.in + (edge - orig.start) * orig.speed));
          const nstart = Math.max(0, orig.start + (nin - orig.in) / orig.speed);
          A.trimClip(c.id, track.kind === 'main' ? { in: nin } : { in: nin, start: nstart }, { coalesce: 'trim:' + c.id });
          setDrag({ ...d, snap: sn.at }); set({ playhead: track.kind === 'main' ? orig.start : nstart });
        } else {
          const endT = orig.start + clipDuration(orig) + dt;
          const sn = snapTo(endT, c.id);
          const nout = Math.max(orig.in + MIN_CLIP, Math.min(maxOut, orig.in + (sn.t - orig.start) * orig.speed));
          A.trimClip(c.id, { out: nout }, { coalesce: 'trim:' + c.id });
          setDrag({ ...d, snap: sn.at }); set({ playhead: orig.start + (nout - orig.in) / orig.speed - 0.001 });
        }
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); dragRef.current = null; setDrag(null); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      return;
    }
    // Перемещение клипа
    const d0: Drag = { kind: 'move', id: c.id, fromTrack: track.id, x0, y0, origStart: c.start, dur: clipDuration(c), moved: false, dx: 0, dy: 0, target: track.id, start: c.start };
    dragRef.current = d0;
    const move = (ev: PointerEvent) => {
      const cur = dragRef.current as Extract<Drag, { kind: 'move' }>;
      if (!cur.moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
      const row = rowAt(ev.clientY);
      const target = row && canGo(c, m, row.track) ? row.track : project.tracks.find(t => t.id === track.id)!;
      const fromRow = rows.find(r => r.track.id === track.id)!;
      const targetRow = rows.find(r => r.track.id === target.id)!;
      let next: Drag;
      if (target.kind === 'main') {
        const t = timeAt(ev.clientX);
        const index = mainIndexAt(t, c.id);
        next = { ...cur, moved: true, dx: ev.clientX - x0, dy: targetRow.top - fromRow.top, target: target.id, start: t, index, snap: undefined };
      } else {
        const raw = Math.max(0, cur.origStart + (ev.clientX - x0) / zoom);
        const sn = snapTo(raw, c.id, cur.dur);
        const st = Math.max(0, sn.t);
        next = { ...cur, moved: true, dx: (st - cur.origStart) * zoom, dy: targetRow.top - fromRow.top, target: target.id, start: st, index: undefined, snap: sn.at };
      }
      dragRef.current = next;
      setDrag(next);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const cur = dragRef.current as Extract<Drag, { kind: 'move' }> | null;
      dragRef.current = null;
      setDrag(null);
      if (!cur || !cur.moved) return;
      const target = project.tracks.find(t => t.id === cur.target);
      if (!target) return;
      if (target.kind === 'main') {
        const main = project.tracks.find(t => t.kind === 'main')!;
        const oldIndex = main.clips.findIndex(x => x.id === c.id);
        if (track.kind === 'main' && cur.index === oldIndex) return;
        A.moveClip(c.id, { index: cur.index, trackId: target.id });
        toast('info', track.kind === 'main' ? 'Клип переставлен' : 'Клип перенесён на основную дорожку', { ttl: 1600 });
      } else {
        if (target.id === track.id && Math.abs(cur.start - cur.origStart) < 1e-4) return;
        A.moveClip(c.id, { start: cur.start, trackId: target.id });
        toast('info', `Клип перемещён на ${formatTime(cur.start, project.fps, true)}`, { ttl: 1600 });
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onClipMenu = (e: React.MouseEvent, c: Clip, track: Track) => {
    e.preventDefault();
    e.stopPropagation();
    const s = get();
    const ids = s.selection.includes(c.id) ? s.selection : [c.id];
    if (!s.selection.includes(c.id)) set({ selection: [c.id] });
    const t = timeAt(e.clientX);
    const m = c.type === 'media' ? media.get(c.mediaId) : undefined;
    const items: MenuItem[] = [
      { label: 'Разрезать здесь', icon: <Scissors size={14} />, shortcut: 'S', onClick: () => A.splitAt(t, c.id) },
      { label: 'Копировать', icon: <Copy size={14} />, shortcut: 'Ctrl+C', onClick: () => A.copyClips(ids) },
      { label: 'Дублировать', icon: <CopyPlus size={14} />, shortcut: 'Ctrl+D', onClick: () => A.duplicateClips(ids) },
    ];
    if (c.type === 'media') {
      items.push({ separator: true }, { header: 'Скорость' });
      for (const sp of [0.25, 0.5, 1, 1.5, 2, 4]) items.push({ label: (c.speed === sp ? '✓ ' : '') + `×${sp}${sp === 1 ? ' (обычная)' : sp < 1 ? ' — замедление' : ' — ускорение'}`, icon: <Gauge size={14} />, onClick: () => A.updateMediaClip(c.id, { speed: sp }, `Скорость ×${sp}`, { coalesce: '' }) });
      items.push({ separator: true });
      if (m?.kind === 'video') {
        items.push({ label: 'Стоп-кадр (2 секунды)', icon: <Snowflake size={14} />, onClick: () => { set({ playhead: Math.min(Math.max(t, c.start), clipEnd(c) - 0.01) }); A.freezeFrame(c.id); } });
        if (m.hasAudio) items.push({ label: 'Отделить звук', icon: <AudioLines size={14} />, onClick: () => A.detachAudio(c.id) });
        items.push({ label: 'Разрезать по сценам', icon: <Scissors size={14} />, onClick: () => A.detectScenes(c.id).catch(err => toast('error', String(err.message || err))) });
      }
      if (m?.hasAudio && track.kind === 'main') items.push({ label: 'Убрать паузы в речи', icon: <Scissors size={14} />, onClick: () => A.removeSilence({ clipId: c.id }) });
      if (m?.hasAudio) items.push({ label: c.muted ? 'Включить звук' : 'Выключить звук', icon: c.muted ? <Volume2 size={14} /> : <VolumeX size={14} />, onClick: () => A.updateMediaClip(c.id, { muted: !c.muted }, c.muted ? 'Звук включён' : 'Звук выключен', { coalesce: '' }) });
      if (track.kind === 'audio') items.push({ label: (c.duck ? '✓ ' : '') + 'Приглушать под голос', icon: <Volume2 size={14} />, onClick: () => A.updateMediaClip(c.id, { duck: !c.duck }, c.duck ? 'Приглушение выключено' : 'Музыка тише, когда говорят', { coalesce: '' }) });
      if (m) items.push({ label: 'Показать файл в папке', icon: <Film size={14} />, onClick: () => api.showItem(m.path) });
    }
    items.push({ separator: true },
      { label: 'Удалить', icon: <Trash2 size={14} />, shortcut: 'Del', danger: true, onClick: () => A.deleteClips(ids) },
      ...(track.kind !== 'main' ? [{ label: 'Удалить и сдвинуть остальное', icon: <Trash2 size={14} />, shortcut: 'Shift+Del', danger: true, onClick: () => A.rippleDelete(ids) }] : []));
    openMenu(items, e.clientX, e.clientY);
  };

  // ── Мышь: пустое место, линейка, ножницы ─────────
  const scrubFrom = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const seek = (x: number) => set({ playhead: Math.min(timeAt(x), Math.max(duration, 0)), playing: false });
    seek(e.clientX);
    dragRef.current = { kind: 'scrub' };
    const move = (ev: PointerEvent) => seek(ev.clientX);
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); dragRef.current = null; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const onEmptyDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    set({ selection: [] });
    scrubFrom(e);
  };

  // Ctrl + колесо — масштаб вокруг курсора
  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey) return;
    const el = scrollRef.current!;
    const t = timeAt(e.clientX);
    const nz = Math.max(4, Math.min(600, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    set({ zoom: nz });
    requestAnimationFrame(() => { el.scrollLeft = t * nz - (e.clientX - el.getBoundingClientRect().left); });
  };
  useEffect(() => {
    // запрещаем масштабирование всей страницы Ctrl+колесом над таймлайном
    const el = scrollRef.current!;
    const h = (e: WheelEvent) => { if (e.ctrlKey) e.preventDefault(); };
    el.addEventListener('wheel', h, { passive: false });
    return () => el.removeEventListener('wheel', h);
  }, []);

  // ── Перетаскивание из медиатеки и панели текста ─
  const onDragOver = (e: React.DragEvent) => {
    const t = e.dataTransfer.types;
    if (!t.includes(DND_MEDIA) && !t.includes(DND_TEXT) && !t.includes('Files')) return;
    e.preventDefault();
    const row = rowAt(e.clientY);
    const time = timeAt(e.clientX);
    if (row?.track.kind === 'main' && !t.includes(DND_TEXT)) {
      const index = mainIndexAt(time);
      setDropHint({ x: indexX(index), track: row.track.id, index });
    } else setDropHint({ x: time * zoom, track: row?.track.id ?? null });
  };
  const onDrop = (e: React.DragEvent) => {
    const hint = dropHint;
    setDropHint(null);
    const time = timeAt(e.clientX);
    const row = rowAt(e.clientY);
    const mediaId = e.dataTransfer.getData(DND_MEDIA);
    const textId = e.dataTransfer.getData(DND_TEXT);
    if (mediaId) {
      e.preventDefault();
      const m = media.get(mediaId);
      if (!m) return;
      if (m.kind === 'audio') A.addToTimeline(mediaId, 'audio', { start: time, trackId: row?.track.kind === 'audio' ? row.track.id : undefined });
      else if (row?.track.kind === 'main' || (!row && !project.tracks.find(t => t.kind === 'main')!.clips.length)) A.addToTimeline(mediaId, 'main', { index: hint?.index });
      else A.addToTimeline(mediaId, 'overlay', { start: time, trackId: row?.track.kind === 'video' ? row.track.id : undefined });
      return;
    }
    if (textId) {
      e.preventDefault();
      const p = presetById(textId);
      if (p) { A.addText(p.text, time, p.duration, p.style, { in: p.animIn, out: p.animOut }); set({ inspectorTab: 'text' }); }
      return;
    }
    const files = [...e.dataTransfer.files].map(f => api.pathForFile(f)).filter(Boolean);
    if (files.length) { e.preventDefault(); e.stopPropagation(); A.importFiles(files, { toTimeline: true, at: time }); }
  };

  // ── Высота таймлайна ─────────────────────────────
  const onResize = (e: React.PointerEvent) => {
    const y0 = e.clientY, h0 = height;
    let last = h0;
    const move = (ev: PointerEvent) => { last = Math.round(Math.max(170, Math.min(window.innerHeight * 0.7, h0 - (ev.clientY - y0)))); setHeight(last); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); saveLayout({ timeline: last }); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const transitionMenu = (e: React.MouseEvent, c: MediaClip) => {
    e.stopPropagation();
    set({ selection: [c.id], playhead: Math.max(0, c.start - 0.4) });
    const cur = c.transition;
    openMenu([
      { header: 'Переход между клипами' },
      { label: (cur ? '' : '✓ ') + 'Без перехода (резкая склейка)', onClick: () => A.setTransition(c.id, 'none') },
      ...TRANSITIONS.map(t => ({ label: (cur?.type === t.id ? '✓ ' : '') + t.label, icon: <Blend size={14} />, onClick: () => A.setTransition(c.id, t.id as TransitionType, cur?.duration ?? 0.6) })),
      { separator: true }, { header: 'Длительность' },
      ...[0.3, 0.6, 1, 1.5, 2].map(d => ({ label: (cur?.duration === d ? '✓ ' : '') + `${d} с`, disabled: !cur, onClick: () => cur && A.setTransition(c.id, cur.type, d) })),
    ], e.clientX, e.clientY);
  };

  const headMenu = (e: React.MouseEvent, t: Track) => {
    e.preventDefault();
    openMenu([
      { header: t.name },
      { label: 'Переименовать', onClick: () => setRenaming(t.id) },
      { label: t.locked ? 'Снять замок' : 'Закрепить (защитить от изменений)', icon: <Lock size={14} />, onClick: () => A.updateTrack(t.id, { locked: !t.locked }, t.locked ? 'Дорожка открыта' : 'Дорожка закреплена') },
      { separator: true },
      { label: 'Новая дорожка наложения', icon: <Layers size={14} />, onClick: () => A.addTrackAction('video') },
      { label: 'Новая дорожка текста', icon: <Type size={14} />, onClick: () => A.addTrackAction('text') },
      { label: 'Новая звуковая дорожка', icon: <Music size={14} />, onClick: () => A.addTrackAction('audio') },
      ...(t.kind !== 'main' ? [{ separator: true }, { label: 'Удалить дорожку', icon: <Trash2 size={14} />, danger: true, onClick: () => A.deleteTrack(t.id) }] : []),
    ], e.clientX, e.clientY);
  };

  const markerMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault(); e.stopPropagation();
    const mk = project.markers.find(m => m.id === id)!;
    openMenu([
      { header: mk.label },
      ...['#ffb547', '#5ce1ff', '#3ddc97', '#ff5c8a', '#a78bfa'].map(color => ({ label: color === mk.color ? '● Цвет (текущий)' : '● Цвет', icon: <span style={{ width: 10, height: 10, borderRadius: 3, background: color, display: 'block' }} />, onClick: () => commit('Цвет метки', p => { p.markers.find(m => m.id === id)!.color = color; }) })),
      { label: 'Переименовать…', onClick: () => { const n = window.prompt('Название метки', mk.label); if (n) commit('Метка переименована', p => { p.markers.find(m => m.id === id)!.label = n; }); } },
      { label: 'Удалить метку', danger: true, icon: <Trash2 size={14} />, onClick: () => commit('Метка удалена', p => { p.markers = p.markers.filter(m => m.id !== id); }) },
    ], e.clientX, e.clientY);
  };

  const zoomSlider = Math.log(zoom / 4) / Math.log(150);
  const moveDrag = drag?.kind === 'move' && drag.moved ? drag : null;
  const snapAt = drag && drag.kind !== 'scrub' ? drag.snap : undefined;
  const empty = !project.tracks.some(t => t.clips.length);

  return (
    <div className="timeline" style={{ height }}>
      <div className="tl-resize" onPointerDown={onResize} data-tip="Потяните, чтобы изменить высоту" data-tip-pos="top" />
      <div className="tl-toolbar">
        <button className={'icon-btn' + (tool === 'select' ? ' active' : '')} onClick={() => set({ tool: 'select' })} data-tip={'Выбор и перемещение\nV'}><MousePointer2 size={16} /></button>
        <button className={'icon-btn' + (tool === 'razor' ? ' active' : '')} onClick={() => set({ tool: tool === 'razor' ? 'select' : 'razor' })} data-tip={'Ножницы: щёлкните по клипу, чтобы разрезать\nC'}><Scissors size={16} /></button>
        <div className="sep" />
        <button className="icon-btn" onClick={() => commandById('split').run()} data-tip={'Разрезать по линии времени\nS'}><SquareSplitHorizontal size={16} /></button>
        <button className="icon-btn" disabled={!selection.length} onClick={() => A.deleteClips(get().selection)} data-tip={'Удалить выбранное\nDel'}><Trash2 size={16} /></button>
        <button className="icon-btn" onClick={() => { A.addText('Ваш текст'); set({ inspectorTab: 'text' }); }} data-tip={'Добавить текст\nT'}><Type size={16} /></button>
        <button className="icon-btn" onClick={() => A.addMarker(get().playhead)} data-tip={'Поставить метку\nM'}><Bookmark size={16} /></button>
        <button className="icon-btn" disabled={selection.length !== 1} onClick={() => A.freezeFrame(selection[0])} data-tip="Стоп-кадр из выбранного видео"><Snowflake size={16} /></button>
        <div className="sep" />
        <button className={'icon-btn' + (snapping ? ' active' : '')} onClick={() => saveSettings({ snapping: !snapping })} data-tip={'Прилипание к краям клипов и линии времени\nN'}><Magnet size={16} /></button>
        <button className="btn small ghost" onClick={e => openMenu([
          { header: 'Добавить дорожку' },
          { label: 'Наложение (видео поверх видео)', icon: <Layers size={14} />, onClick: () => A.addTrackAction('video') },
          { label: 'Текст', icon: <Type size={14} />, onClick: () => A.addTrackAction('text') },
          { label: 'Звук', icon: <Music size={14} />, onClick: () => A.addTrackAction('audio') },
        ], e.clientX, e.clientY)}><Plus size={14} /> Дорожка</button>
        <div className="spacer" />
        {tool === 'razor' && <span className="badge" style={{ color: 'var(--bad)', borderColor: 'var(--bad)' }}>Режим ножниц · Esc — выйти</span>}
        <button className="icon-btn" onClick={() => set({ zoom: Math.max(4, zoom / 1.4) })} data-tip={'Отдалить\n−  или  Ctrl + колесо'}><ZoomOut size={16} /></button>
        <input type="range" min={0} max={1} step={0.001} value={zoomSlider} style={{ width: 110, ['--fill' as string]: `${zoomSlider * 100}%` }}
          onChange={e => set({ zoom: 4 * Math.pow(150, Number(e.target.value)) })} data-tip="Масштаб таймлайна" />
        <button className="icon-btn" onClick={() => set({ zoom: Math.min(600, zoom * 1.4) })} data-tip={'Приблизить\n='}><ZoomIn size={16} /></button>
        <button className="icon-btn" onClick={A.fitZoom} data-tip={'Показать весь ролик\nShift+Z'}><Maximize2 size={15} /></button>
      </div>
      <div className="tl-body">
        <div className="tl-heads">
          <div className="tl-heads-inner" style={{ transform: `translateY(${-scroll.top}px)` }}>
            {rows.map(({ track: t, h }) => {
              const Icon = ICONS[t.kind];
              return (
                <div key={t.id} className="tl-head" style={{ height: h }} onContextMenu={e => headMenu(e, t)}>
                  <span className="tcolor" style={{ background: COLORS[t.kind] }} />
                  <span className="tname" onDoubleClick={() => setRenaming(t.id)}>
                    <Icon size={13} color={COLORS[t.kind]} style={{ flex: 'none' }} />
                    {renaming === t.id
                      ? <input autoFocus className="input" style={{ height: 22, fontSize: 12, padding: '0 5px' }} defaultValue={t.name}
                        onBlur={e => { const n = e.target.value.trim(); if (n && n !== t.name) A.updateTrack(t.id, { name: n }, 'Дорожка переименована'); setRenaming(null); }}
                        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null); }} />
                      : <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</span>}
                  </span>
                  {t.kind !== 'audio' && (
                    <button className="icon-btn small" onClick={() => A.updateTrack(t.id, { hidden: !t.hidden }, t.hidden ? 'Дорожка снова видна' : 'Дорожка скрыта')} data-tip={t.hidden ? 'Показать' : 'Скрыть в видео'}>
                      {t.hidden ? <EyeOff size={13} color="var(--warn)" /> : <Eye size={13} />}
                    </button>
                  )}
                  {t.kind !== 'text' && (
                    <button className="icon-btn small" onClick={() => A.updateTrack(t.id, { muted: !t.muted }, t.muted ? 'Звук дорожки включён' : 'Звук дорожки выключен')} data-tip={t.muted ? 'Включить звук' : 'Выключить звук'}>
                      {t.muted ? <VolumeX size={13} color="var(--warn)" /> : <Volume2 size={13} />}
                    </button>
                  )}
                  <button className="icon-btn small" onClick={() => A.updateTrack(t.id, { locked: !t.locked }, t.locked ? 'Дорожка открыта' : 'Дорожка закреплена')} data-tip={t.locked ? 'Снять замок' : 'Закрепить: защитить от случайных изменений'}>
                    {t.locked ? <Lock size={13} color="var(--warn)" /> : <LockOpen size={13} />}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
        <div className={'tl-scroll' + (tool === 'razor' ? ' razor-cursor' : '')} ref={scrollRef} onScroll={onScroll} onWheel={onWheel}
          onDragOver={onDragOver} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropHint(null); }} onDrop={onDrop}
          onMouseMove={e => tool === 'razor' && setRazorX(timeAt(e.clientX) * zoom)} onMouseLeave={() => setRazorX(null)}>
          <div className="tl-content" ref={contentRef} style={{ width: contentW, height: RULER_H + rowsH + 40 }}>
            <div className="ruler" onPointerDown={scrubFrom} data-tip="Щёлкните или потяните, чтобы перемотать" data-tip-pos="right">
              <canvas ref={rulerRef} style={{ left: scroll.left, position: 'absolute' }} />
              {project.markers.map(mk => (
                <div key={mk.id} className="marker" style={{ left: mk.time * zoom, top: 16, background: mk.color }} data-tip={mk.label}
                  onPointerDown={e => { e.stopPropagation(); set({ playhead: mk.time, playing: false }); }} onContextMenu={e => markerMenu(e, mk.id)} />
              ))}
            </div>
            {project.markers.map(mk => <div key={mk.id} className="marker-line" style={{ left: mk.time * zoom, background: mk.color }} />)}
            <div onPointerDown={onEmptyDown}>
              {rows.map(({ track: t, h }) => (
                <div key={t.id} className={'track-row ' + t.kind + (t.locked ? ' locked' : '') + (dropHint?.track === t.id || (moveDrag && moveDrag.target === t.id && moveDrag.target !== moveDrag.fromTrack) ? ' drop-ok' : '')} style={{ height: h }}>
                  {t.clips.map((c, i) => {
                    const dragging = moveDrag?.id === c.id ? moveDrag : null;
                    const m = c.type === 'media' ? media.get(c.mediaId) : undefined;
                    return (
                      <ClipView key={c.id} clip={c} track={t} media={m} cache={m ? cache[m.id] : undefined} zoom={zoom} height={h}
                        selected={selection.includes(c.id)} flash={!drag && Date.now() - (flash[c.id] || 0) < 1200}
                        offset={dragging ? { x: dragging.dx, y: dragging.dy } : null} razor={tool === 'razor'}
                        onDown={(e, part) => onClipDown(e, c, t, part)} onMenu={e => onClipMenu(e, c, t)}
                        transitionMark={t.kind === 'main' && i > 0 && c.type === 'media' ? { on: !!c.transition, td: transitionDuration(t.clips[i - 1], c), onClick: (e: React.MouseEvent) => transitionMenu(e, c) } : undefined} />
                    );
                  })}
                  {t.kind === 'main' && !t.clips.length && <div className="tl-empty" style={{ textAlign: 'left', paddingLeft: 16 }}>Основное видео: перетащите сюда файлы из медиатеки</div>}
                </div>
              ))}
            </div>
            {empty && <div className="tl-empty" style={{ top: RULER_H + rowsH + 18 }}>Двойной щелчок по файлу в медиатеке — и он окажется здесь</div>}
            {moveDrag?.index !== undefined && <div className="drop-indicator" style={{ left: indexX(moveDrag.index, moveDrag.id) - 1, top: RULER_H + (rows.find(r => r.track.kind === 'main')?.top ?? 0) + 2, height: TRACK_H.main - 4, bottom: 'auto' }} />}
            {dropHint && (
              <div className="drop-indicator" style={{ left: dropHint.x - 1, top: RULER_H + (rows.find(r => r.track.id === dropHint.track)?.top ?? 0) + 2, height: (rows.find(r => r.track.id === dropHint.track)?.h ?? rowsH) - 4, bottom: 'auto' }} />
            )}
            {snapAt !== undefined && <div className="snap-line" style={{ left: snapAt * zoom }} />}
            {razorX !== null && <div className="razor-line" style={{ left: razorX }} />}
            <Playhead zoom={zoom} scrollRef={scrollRef} />
          </div>
        </div>
      </div>
    </div>
  );
}

// Линия времени. Отдельный компонент, чтобы при просмотре не перерисовывать все клипы 60 раз в секунду
function Playhead({ zoom, scrollRef }: { zoom: number; scrollRef: React.RefObject<HTMLDivElement | null> }) {
  const playhead = useStore(s => s.playhead);
  const playing = useStore(s => s.playing);
  useEffect(() => {
    // при просмотре линия не уходит за край
    const el = scrollRef.current;
    if (!el || !playing) return;
    const x = playhead * zoom;
    if (x > el.scrollLeft + el.clientWidth - 60 || x < el.scrollLeft) el.scrollLeft = x - el.clientWidth * 0.2;
  }, [playhead, playing, zoom]);
  return <div className="playhead" style={{ left: playhead * zoom - 1 }} />;
}

// ── Один клип на таймлайне ───────────────────────────
const ClipView = memo(function ClipView(p: {
  clip: Clip; track: Track; media?: MediaItem; cache?: MediaCacheEntry; zoom: number; height: number; selected: boolean; flash: boolean;
  offset: { x: number; y: number } | null; razor: boolean;
  onDown: (e: React.PointerEvent, part: 'body' | 'l' | 'r') => void; onMenu: (e: React.MouseEvent) => void;
  transitionMark?: { on: boolean; td: number; onClick: (e: React.MouseEvent) => void };
}) {
  const c = p.clip;
  const dur = clipDuration(c);
  const left = c.start * p.zoom;
  const width = Math.max(4, dur * p.zoom);
  const kind = p.track.kind;
  const isText = c.type === 'text';
  const mc = c.type === 'media' ? c : null;
  const m = p.media;
  const color = kind === 'video' && m?.kind === 'audio' ? COLORS.audio : COLORS[m?.kind === 'audio' ? 'audio' : kind];
  const missing = !!m?.missing;
  const showStrip = mc && m && m.kind !== 'audio' && p.height > 45;
  const showWave = mc && m?.hasAudio && p.cache?.waveform?.length && (kind === 'audio' || m.kind === 'audio' || p.height > 60);
  const disabled = p.track.hidden || (mc && (mc.muted || p.track.muted) && m?.kind === 'audio');
  const style: React.CSSProperties = {
    left, width,
    background: `linear-gradient(180deg, color-mix(in srgb, ${color} 92%, #fff 8%), color-mix(in srgb, ${color} 70%, #000 30%))`,
    transform: p.offset ? `translate(${p.offset.x}px, ${p.offset.y}px)` : undefined,
    cursor: p.razor ? 'crosshair' : undefined,
  };
  const badges: React.ReactNode[] = [];
  if (mc) {
    if (mc.speed !== 1) badges.push(<span key="s"><Gauge size={9} />×{+mc.speed.toFixed(2)}</span>);
    if (mc.color.preset !== 'none') badges.push(<span key="c">{COLOR_PRESETS[mc.color.preset]?.label}</span>);
    if (mc.animate) badges.push(<span key="a"><Move size={9} /></span>);
    if (mc.muted) badges.push(<span key="m"><VolumeX size={9} /></span>);
    if (mc.duck) badges.push(<span key="d">тише под голос</span>);
  }
  return (
    <>
      <div className={'clip' + (p.selected ? ' selected' : '') + (p.flash ? ' flash' : '') + (p.offset ? ' dragging' : '') + (missing ? ' missing' : '') + (disabled ? ' disabled' : '')}
        style={style} onPointerDown={e => p.onDown(e, 'body')} onContextMenu={p.onMenu}>
        <div className="c-label">
          {isText ? <Type size={11} /> : m?.kind === 'image' ? <ImageIcon size={11} /> : m?.kind === 'audio' ? <Music size={11} /> : <Film size={11} />}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{isText ? (c as TextClip).text.replace(/\n/g, ' ') : missing ? `Нет файла: ${m?.name}` : m?.name}</span>
          {width > 90 && <span style={{ opacity: 0.7, marginLeft: 'auto', paddingRight: badges.length ? 0 : 4 }}>{formatTime(dur)}</span>}
        </div>
        {badges.length > 0 && width > 120 && <div className="fx-badges" style={{ top: 'auto', bottom: 4 }}>{badges}</div>}
        {showStrip && <Filmstrip clip={mc!} media={m!} cache={p.cache} width={width} height={p.height - 30} zoom={p.zoom} />}
        {showWave && <Wave clip={mc!} media={m!} peaks={p.cache!.waveform!} width={width} height={m!.kind === 'audio' ? p.height - 28 : 18} />}
        {mc && mc.fadeIn > 0 && <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: mc.fadeIn * p.zoom, background: 'linear-gradient(to right, rgba(0,0,0,.55), transparent)', pointerEvents: 'none' }} />}
        {mc && mc.fadeOut > 0 && <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: mc.fadeOut * p.zoom, background: 'linear-gradient(to left, rgba(0,0,0,.55), transparent)', pointerEvents: 'none' }} />}
        {!p.razor && !p.track.locked && <>
          <div className="handle l" onPointerDown={e => p.onDown(e, 'l')} data-tip="Потяните, чтобы обрезать начало" data-tip-pos="top" />
          <div className="handle r" onPointerDown={e => p.onDown(e, 'r')} data-tip="Потяните, чтобы обрезать конец" data-tip-pos="top" />
        </>}
      </div>
      {p.transitionMark && !p.offset && (
        <div className={'transition-mark' + (p.transitionMark.on ? ' on' : ' empty')} style={{ left: left + (p.transitionMark.td * p.zoom) / 2 }}
          onPointerDown={e => e.stopPropagation()} onClick={p.transitionMark.onClick}
          data-tip={p.transitionMark.on ? `Переход: ${TRANSITIONS.find(t => t.id === (c as MediaClip).transition?.type)?.label}\nнажмите, чтобы изменить` : 'Добавить переход'}>
          {p.transitionMark.on ? <Blend size={11} /> : <Plus size={11} />}
        </div>
      )}
    </>
  );
});

function Filmstrip({ clip, media, cache, width, height, zoom }: { clip: MediaClip; media: MediaItem; cache?: MediaCacheEntry; width: number; height: number; zoom: number }) {
  const strip = cache?.filmstrip || [];
  const tileW = Math.max(30, height * (media.width / Math.max(1, media.height) || 16 / 9));
  const n = Math.min(200, Math.ceil(width / tileW));
  const tiles: string[] = [];
  for (let i = 0; i < n; i++) {
    if (media.kind === 'image' || !strip.length) { tiles.push(cache?.thumb || ''); continue; }
    const src = clip.in + ((i + 0.5) * tileW / zoom) * clip.speed;
    tiles.push(strip[Math.max(0, Math.min(strip.length - 1, Math.floor((src / Math.max(0.01, media.duration)) * strip.length)))]);
  }
  return (
    <div className="c-strip">
      {tiles.map((t, i) => <div key={i} style={{ width: tileW, backgroundImage: t ? `url("kadr-media://local/${encodeURIComponent(t)}")` : undefined }} />)}
    </div>
  );
}

const Wave = memo(function Wave({ clip, media, peaks, width, height }: { clip: MediaClip; media: MediaItem; peaks: number[]; width: number; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const W = Math.min(4000, Math.max(1, Math.round(width)));
    const H = Math.max(4, Math.round(height));
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d')!;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,.75)';
    const total = peaks.length;
    const dur = Math.max(0.01, media.duration);
    const gain = Math.min(2, clip.volume * (clip.muted ? 0.15 : 1)) || 0.05;
    for (let x = 0; x < W; x++) {
      const t0 = clip.in + (x / W) * (clip.out - clip.in);
      const t1 = clip.in + ((x + 1) / W) * (clip.out - clip.in);
      const i0 = Math.floor((t0 / dur) * total), i1 = Math.max(i0 + 1, Math.floor((t1 / dur) * total));
      let peak = 0;
      for (let i = i0; i < i1 && i < total; i++) peak = Math.max(peak, peaks[i]);
      const h = Math.max(1, Math.min(1, peak * gain) * H);
      ctx.fillRect(x, H - h, 1, h);
    }
  }, [peaks, clip.in, clip.out, clip.volume, clip.muted, width, height, media.duration]);
  return <canvas ref={ref} className="c-wave" style={{ height }} />;
});

