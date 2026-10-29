// Левая панель: медиатека, готовые тексты, переходы, фильтры, запись с микрофона и камеры, ИИ-инструменты.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Blend, Camera, Captions, Clapperboard, Film, FolderOpen, Image as ImageIcon, Layers, Mic, Music, Plus, Scissors,
  Sparkles, Square, Trash2, Type, Upload, Video, Wand2, WandSparkles, AudioLines, TriangleAlert,
} from 'lucide-react';
import { api, mediaUrl } from '../api';
import type { MediaClip, MediaItem, TransitionType } from '../../shared/types';
import { COLOR_PRESETS, findClip, formatTime, mainTrack, TRANSITIONS } from '../../shared/timeline';
import { providerPreset } from '../../shared/providers';
import { get, set, toast, useStore } from '../state/store';
import * as A from '../state/actions';
import { askAssistant } from '../state/assistant';
import { TEXT_PRESETS } from '../lib/text-presets';
import { transitionFx } from '../lib/transition-fx';
import { DND_MEDIA, DND_TEXT } from '../lib/dnd';
import { openMenu, Segmented, Slider } from './ui';

export type RailTab = 'media' | 'text' | 'transitions' | 'filters' | 'record' | 'ai';

const RAIL: { id: RailTab; label: string; icon: typeof Film; tip: string }[] = [
  { id: 'media', label: 'Медиа', icon: Film, tip: 'Ваши видео, фото и музыка' },
  { id: 'text', label: 'Текст', icon: Type, tip: 'Заголовки, подписи, субтитры' },
  { id: 'transitions', label: 'Переходы', icon: Blend, tip: 'Плавные склейки между клипами' },
  { id: 'filters', label: 'Фильтры', icon: Wand2, tip: 'Цвет и эффекты' },
  { id: 'record', label: 'Запись', icon: Mic, tip: 'Голос с микрофона или видео с камеры' },
  { id: 'ai', label: 'ИИ', icon: Sparkles, tip: 'Автоматический монтаж' },
];

export function LeftRail({ tab, onTab }: { tab: RailTab | null; onTab: (t: RailTab) => void }) {
  return (
    <div className="left-rail">
      {RAIL.map(r => (
        <button key={r.id} className={'rail-btn' + (tab === r.id ? ' on' : '')} onClick={() => onTab(r.id)} data-tip={r.tip} data-tip-pos="right">
          <r.icon size={19} />{r.label}
        </button>
      ))}
    </div>
  );
}

export function SidePanel({ tab }: { tab: RailTab }) {
  return (
    <div className="side-panel" key={tab}>
      {tab === 'media' && <MediaPanel />}
      {tab === 'text' && <TextPanel />}
      {tab === 'transitions' && <TransitionsPanel />}
      {tab === 'filters' && <FiltersPanel />}
      {tab === 'record' && <RecordPanel />}
      {tab === 'ai' && <AiPanel />}
    </div>
  );
}

// ── Медиатека ────────────────────────────────────────
function MediaPanel() {
  const media = useStore(s => s.project!.media);
  const cache = useStore(s => s.mediaCache);
  const [filter, setFilter] = useState<'all' | 'video' | 'image' | 'audio'>('all');
  const [over, setOver] = useState(false);
  const tracks = useStore(s => s.project!.tracks);
  const used = useMemo(() => new Set(tracks.flatMap(t => t.clips.map(c => (c.type === 'media' ? c.mediaId : '')))), [tracks]);
  const list = media.filter(m => filter === 'all' || m.kind === filter);
  const add = async () => A.importFiles(await api.openMediaDialog());

  return (
    <>
      <div className="panel-head"><Film size={16} /><h3>Медиатека</h3><span className="muted small-text">{media.length}</span>
        <button className="icon-btn" data-tip="Добавить файлы (Ctrl+I)" onClick={add}><Plus size={16} /></button>
      </div>
      <div className="panel-body">
        <div className={'dropzone' + (over ? ' over' : '')} onClick={add}
          onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setOver(true); } }}
          onDragLeave={() => setOver(false)}
          onDrop={e => {
            setOver(false);
            const files = [...e.dataTransfer.files].map(f => api.pathForFile(f)).filter(Boolean);
            if (files.length) { e.preventDefault(); e.stopPropagation(); A.importFiles(files); }
          }}>
          <Upload size={22} />
          <div><b style={{ color: 'var(--text)' }}>Добавить файлы</b><br /><span className="small-text">или перетащите их сюда из папки</span></div>
        </div>
        {media.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <Segmented value={filter} onChange={setFilter} options={[
              { value: 'all', label: 'Все' }, { value: 'video', label: <Video size={14} />, tip: 'Видео' },
              { value: 'image', label: <ImageIcon size={14} />, tip: 'Фото' }, { value: 'audio', label: <Music size={14} />, tip: 'Звук' },
            ]} />
          </div>
        )}
        <div className="media-grid">
          {list.map(m => <MediaCard key={m.id} m={m} thumb={cache[m.id]?.thumb} strip={cache[m.id]?.filmstrip || []} loading={!!cache[m.id]?.loading} used={used.has(m.id)} />)}
        </div>
        {!media.length && (
          <div className="empty-hint">
            Здесь будут ваши файлы.<br />Потом перетащите их вниз, на таймлайн, — или дважды щёлкните по файлу.
          </div>
        )}
        {media.length > 0 && <div className="empty-hint" style={{ paddingTop: 12 }}>Двойной щелчок — добавить в конец ролика. Перетаскивание — в нужное место.</div>}
      </div>
    </>
  );
}

function MediaCard({ m, thumb, strip, loading, used }: { m: MediaItem; thumb?: string; strip: string[]; loading: boolean; used: boolean }) {
  const [scrub, setScrub] = useState<number | null>(null);
  const Icon = m.kind === 'video' ? Video : m.kind === 'image' ? ImageIcon : Music;
  const frame = scrub !== null && strip.length ? strip[Math.min(strip.length - 1, Math.floor(scrub * strip.length))] : thumb;
  const menu = (x: number, y: number) => openMenu([
    { header: m.name },
    ...(m.kind !== 'audio' ? [
      { label: 'В конец основного видео', icon: <Film size={14} />, onClick: () => A.addToTimeline(m.id, 'main') },
      { label: 'Поверх видео (картинка в картинке)', icon: <Layers size={14} />, onClick: () => A.addToTimeline(m.id, 'overlay') },
    ] : [{ label: 'На звуковую дорожку', icon: <Music size={14} />, onClick: () => A.addToTimeline(m.id, 'audio') }]),
    { separator: true },
    { label: 'Показать в папке', icon: <FolderOpen size={14} />, onClick: () => api.showItem(m.path) },
    ...(m.missing ? [{ label: 'Указать, где теперь файл…', icon: <TriangleAlert size={14} />, onClick: () => A.relinkMedia(m.id) }] : []),
    { label: used ? 'Удалить из проекта (и с таймлайна)' : 'Удалить из медиатеки', icon: <Trash2 size={14} />, danger: true, onClick: () => A.removeMedia(m.id) },
  ], x, y);
  return (
    <div className={'media-card' + (m.missing ? ' missing' : '')} draggable={!m.missing}
      onDragStart={e => { e.dataTransfer.setData(DND_MEDIA, m.id); e.dataTransfer.effectAllowed = 'copy'; }}
      onDoubleClick={() => (m.missing ? A.relinkMedia(m.id) : A.addToTimeline(m.id, m.kind === 'audio' ? 'audio' : 'main'))}
      onClick={() => m.missing && A.relinkMedia(m.id)}
      onContextMenu={e => { e.preventDefault(); menu(e.clientX, e.clientY); }}
      data-tip={m.missing ? 'Файл не найден. Нажмите, чтобы указать, где он теперь' : `${m.name}\n${m.kind === 'audio' ? '' : `${m.width}×${m.height} · `}${m.kind === 'image' ? 'фото' : formatTime(m.duration)}`}>
      <div className="media-thumb" style={{ backgroundImage: frame ? `url("${mediaUrl(frame)}")` : undefined }}
        onMouseMove={e => { if (m.kind === 'video') { const r = e.currentTarget.getBoundingClientRect(); setScrub((e.clientX - r.left) / r.width); } }}
        onMouseLeave={() => setScrub(null)}>
        {m.kind === 'audio' && <AudioLines size={28} color="var(--clip-audio)" />}
        {!frame && m.kind !== 'audio' && (loading ? <span className="spinner" /> : <Icon size={22} />)}
        <span className="kind"><Icon size={11} /></span>
        {m.kind !== 'image' && <span className="dur">{formatTime(m.duration)}</span>}
        <button className="icon-btn small add" style={{ background: 'var(--accent)', color: '#fff' }} data-tip="Добавить на таймлайн"
          onClick={e => { e.stopPropagation(); menu(e.clientX, e.clientY); }}><Plus size={14} /></button>
        {scrub !== null && <div style={{ position: 'absolute', left: `${scrub * 100}%`, top: 0, bottom: 0, width: 2, background: 'var(--accent-2)' }} />}
      </div>
      <div className="media-name">{used && <span style={{ color: 'var(--good)' }}>● </span>}{m.name}</div>
    </div>
  );
}

// ── Тексты ───────────────────────────────────────────
function TextPanel() {
  return (
    <>
      <div className="panel-head"><Type size={16} /><h3>Текст</h3></div>
      <div className="panel-body">
        <button className="btn primary" style={{ width: '100%' }} onClick={() => { A.addText('Ваш текст'); set({ inspectorTab: 'text' }); }}><Plus size={15} /> Добавить текст <kbd style={{ marginLeft: 'auto' }}>T</kbd></button>
        <div className="section-title" style={{ marginTop: 16 }}>Готовые стили</div>
        <div className="tile-grid">
          {TEXT_PRESETS.map(p => (
            <button key={p.id} className="tile" draggable
              onDragStart={e => { e.dataTransfer.setData(DND_TEXT, p.id); e.dataTransfer.effectAllowed = 'copy'; }}
              onClick={() => { A.addText(p.text, undefined, p.duration, p.style, { in: p.animIn, out: p.animOut }); set({ inspectorTab: 'text' }); }}
              data-tip="Нажмите или перетащите на таймлайн">
              <div className="t-prev" style={{ background: p.style.background ? 'linear-gradient(135deg,#2a2f45,#151824)' : undefined }}>
                <span style={{
                  fontFamily: p.style.font, fontWeight: p.style.bold ? 700 : 400, fontStyle: p.style.italic ? 'italic' : undefined,
                  textTransform: p.style.uppercase ? 'uppercase' : undefined, color: p.style.color || '#fff', fontSize: p.style.font === 'Press Start 2P' ? 9 : 15,
                  WebkitTextStroke: p.style.strokeWidth ? `${Math.min(2, p.style.strokeWidth / 5)}px ${p.style.strokeColor}` : undefined,
                  background: p.style.background ? p.style.backgroundColor || 'rgba(0,0,0,.55)' : undefined, padding: p.style.background ? '2px 6px' : undefined, borderRadius: 3,
                  textShadow: p.style.shadow !== false ? '0 2px 6px rgba(0,0,0,.6)' : undefined, whiteSpace: 'nowrap',
                }}>{p.text.split('\n')[0]}</span>
              </div>
              <span className="t-name">{p.name}</span>
            </button>
          ))}
        </div>
        <div className="section-title">Субтитры</div>
        <div className="tip-card"><Captions size={18} color="var(--accent)" style={{ flex: 'none' }} />
          <div>ИИ послушает речь в видео и сам расставит субтитры по времени.
            <button className="btn small" style={{ marginTop: 8 }} onClick={() => A.transcribeProject({ addSubs: true }).catch(() => undefined)}><Sparkles size={13} /> Сделать субтитры</button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Переходы ─────────────────────────────────────────
function TransitionTile({ id, label, onPick }: { id: string; label: string; onPick: () => void }) {
  const [p, setP] = useState(0.45);
  const raf = useRef(0);
  const start = () => {
    const t0 = performance.now();
    const loop = () => { setP(((performance.now() - t0) / 1100) % 1); raf.current = requestAnimationFrame(loop); };
    raf.current = requestAnimationFrame(loop);
  };
  const stop = () => { cancelAnimationFrame(raf.current); setP(0.45); };
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  const W = 120, H = 44;
  const a = transitionFx(id, p, false, W, H), b = transitionFx(id, p, true, W, H);
  const layer = (fx: typeof a, bg: string): React.CSSProperties => ({
    position: 'absolute', inset: 0, background: bg, opacity: fx.opacity, transform: `translate(${fx.dx}px, ${fx.dy}px) scale(${fx.scale})`,
    clipPath: fx.clip, WebkitMaskImage: fx.mask, maskImage: fx.mask, display: 'grid', placeItems: 'center', fontWeight: 700, color: 'rgba(255,255,255,.85)',
  });
  return (
    <button className="tile" onMouseEnter={start} onMouseLeave={stop} onClick={onPick} data-tip="Нажмите, чтобы поставить на выбранный стык">
      <div className="t-prev" style={{ background: id === 'fadewhite' ? '#fff' : '#000' }}>
        <div style={layer(a, 'linear-gradient(135deg,#ff7a3d,#ff5c8a)')}>A</div>
        <div style={layer(b, 'linear-gradient(135deg,#3a7bff,#2bd4c5)')}>B</div>
      </div>
      <span className="t-name">{label}</span>
    </button>
  );
}

function TransitionsPanel() {
  const project = useStore(s => s.project)!;
  const selection = useStore(s => s.selection);
  const [dur, setDur] = useState(0.6);
  const main = mainTrack(project);
  const target = selection.map(id => main.clips.findIndex(c => c.id === id)).find(i => i >= 0);
  const apply = (type: string) => {
    let idx = target ?? -1;
    if (idx === 0 && main.clips.length > 1) idx = 1;
    if (idx < 1) {
      // нет выбранного клипа — ставим на ближайший к линии времени стык
      const t = get().playhead;
      let best = -1, dist = Infinity;
      main.clips.forEach((c, i) => { if (i > 0 && Math.abs(c.start - t) < dist) { dist = Math.abs(c.start - t); best = i; } });
      idx = best;
    }
    if (idx < 1) { toast('info', 'Нужно хотя бы два клипа на основной дорожке', { detail: 'Переход ставится на стык между ними.' }); return; }
    A.setTransition(main.clips[idx].id, type as TransitionType, dur);
    set({ selection: [main.clips[idx].id], playhead: Math.max(0, main.clips[idx].start - 0.5) });
  };
  const applyAll = (type: string) => {
    if (main.clips.length < 2) { toast('info', 'Нужно хотя бы два клипа на основной дорожке'); return; }
    A.commitAllTransitions(type as TransitionType, dur);
  };
  return (
    <>
      <div className="panel-head"><Blend size={16} /><h3>Переходы</h3></div>
      <div className="panel-body">
        <div className="tip-card" style={{ marginBottom: 12 }}><Blend size={18} color="var(--accent)" style={{ flex: 'none' }} />
          <div>Выберите клип на основной дорожке и нажмите на переход — он встанет перед этим клипом. Наведите мышь, чтобы увидеть, как он выглядит.</div>
        </div>
        <Slider label="Длительность" value={dur} min={0.2} max={2.5} step={0.05} def={0.6} unit=" с" onChange={setDur} />
        <div className="row" style={{ margin: '8px 0 4px' }}>
          <button className="btn small" onClick={() => applyAll('fade')}>Наплыв на все стыки</button>
          <button className="btn small ghost" onClick={() => applyAll('none')}>Убрать все</button>
        </div>
        <div className="tile-grid" style={{ marginTop: 10 }}>
          {TRANSITIONS.map(t => <TransitionTile key={t.id} id={t.id} label={t.label} onPick={() => apply(t.id)} />)}
        </div>
      </div>
    </>
  );
}

// ── Фильтры и эффекты ────────────────────────────────
const SAMPLE_BG = 'linear-gradient(135deg, #ff9a3d 0%, #ff5c8a 35%, #7c5cff 65%, #2bd4c5 100%)';

function FiltersPanel() {
  const project = useStore(s => s.project)!;
  const selection = useStore(s => s.selection);
  const cache = useStore(s => s.mediaCache);
  const clips = selection.map(id => findClip(project, id)?.clip).filter((c): c is MediaClip => c?.type === 'media');
  const first = clips[0];
  const thumb = first ? cache[first.mediaId]?.thumb : undefined;
  const need = () => { toast('info', 'Сначала выберите видео или фото на таймлайне'); return false; };
  const apply = (label: string, fn: (c: MediaClip) => Parameters<typeof A.updateMediaClip>[1]) => {
    if (!clips.length) return need();
    for (const c of clips) A.updateMediaClip(c.id, fn(c), label, { coalesce: '' });
  };
  const EFFECTS: { label: string; tip: string; on: (c: MediaClip) => boolean; toggle: (c: MediaClip) => Parameters<typeof A.updateMediaClip>[1] }[] = [
    { label: 'Плавное приближение', tip: 'Эффект Кена Бёрнса: кадр медленно наезжает', on: c => c.animate, toggle: c => ({ animate: !c.animate }) },
    { label: 'Виньетка', tip: 'Затемнение по краям кадра', on: c => c.effects.vignette > 0, toggle: c => ({ effects: { vignette: c.effects.vignette > 0 ? 0 : 0.5 } }) },
    { label: 'Плёнка', tip: 'Зерно, как у старой киноплёнки', on: c => c.effects.grain > 0, toggle: c => ({ effects: { grain: c.effects.grain > 0 ? 0 : 0.35 } }) },
    { label: 'Размытие', tip: 'Мягкий фокус', on: c => c.effects.blur > 0, toggle: c => ({ effects: { blur: c.effects.blur > 0 ? 0 : 0.25 } }) },
    { label: 'Резкость', tip: 'Чётче детали', on: c => c.effects.sharpen > 0, toggle: c => ({ effects: { sharpen: c.effects.sharpen > 0 ? 0 : 0.5 } }) },
    { label: 'Зеркально', tip: 'Отразить по горизонтали', on: c => c.effects.flipH, toggle: c => ({ effects: { flipH: !c.effects.flipH } }) },
    { label: 'Появление', tip: 'Плавно из темноты в начале', on: c => c.fadeIn > 0, toggle: c => ({ fadeIn: c.fadeIn > 0 ? 0 : 0.6 }) },
    { label: 'Затухание', tip: 'Плавно в темноту в конце', on: c => c.fadeOut > 0, toggle: c => ({ fadeOut: c.fadeOut > 0 ? 0 : 0.8 }) },
  ];
  return (
    <>
      <div className="panel-head"><Wand2 size={16} /><h3>Фильтры и эффекты</h3></div>
      <div className="panel-body">
        {!clips.length && <div className="tip-card" style={{ marginBottom: 12 }}><Wand2 size={18} color="var(--accent)" style={{ flex: 'none' }} /><div>Щёлкните по клипу на таймлайне, потом выберите фильтр. Можно выбрать несколько клипов с Ctrl.</div></div>}
        {clips.length > 1 && <div className="badge accent" style={{ marginBottom: 10, display: 'inline-block' }}>Применится к {clips.length} клипам</div>}
        <div className="section-title">Цвет</div>
        <div className="preset-grid">
          {Object.entries(COLOR_PRESETS).map(([id, p]) => (
            <button key={id} className={'preset' + (first?.color.preset === id ? ' on' : '')}
              onClick={() => apply(`Фильтр «${p.label}»`, () => ({ color: { preset: id as MediaClip['color']['preset'] } }))}>
              <div className="p-img" style={{ backgroundImage: thumb ? `url("${mediaUrl(thumb)}")` : SAMPLE_BG, filter: p.css || undefined }} />
              <span>{p.label}</span>
            </button>
          ))}
        </div>
        <div className="section-title">Эффекты</div>
        <div className="tile-grid">
          {EFFECTS.map(e => {
            const on = !!first && e.on(first);
            return (
              <button key={e.label} className={'chip' + (on ? ' on' : '')} data-tip={e.tip}
                style={on ? { borderColor: 'var(--accent)', background: 'var(--accent-soft)', color: 'var(--text)' } : undefined}
                onClick={() => apply(on ? `Эффект «${e.label}» выключен` : `Эффект «${e.label}»`, e.toggle)}>
                {on ? '✓ ' : ''}{e.label}
              </button>
            );
          })}
        </div>
        <div className="empty-hint">Тонкая настройка — справа, во вкладках «Цвет» и «Эффекты».</div>
      </div>
    </>
  );
}

// ── Запись голоса и камеры ───────────────────────────
function RecordPanel() {
  const [mode, setMode] = useState<'mic' | 'cam'>('mic');
  const [state, setState] = useState<'idle' | 'ready' | 'rec' | 'saving'>('idle');
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const stream = useRef<MediaStream | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const raf = useRef(0);
  const startedAt = useRef(0);
  const ctxRef = useRef<AudioContext | null>(null);

  const release = () => {
    cancelAnimationFrame(raf.current);
    stream.current?.getTracks().forEach(t => t.stop());
    stream.current = null;
    ctxRef.current?.close().catch(() => undefined);
    ctxRef.current = null;
    setLevel(0);
  };
  useEffect(() => () => { rec.current?.state === 'recording' && rec.current.stop(); release(); }, []);

  const prepare = async (m = mode) => {
    release();
    setError('');
    try {
      const s = await navigator.mediaDevices.getUserMedia(m === 'cam' ? { audio: true, video: { width: 1920, height: 1080 } } : { audio: { echoCancellation: true, noiseSuppression: true } });
      stream.current = s;
      if (m === 'cam' && videoRef.current) { videoRef.current.srcObject = s; videoRef.current.play().catch(() => undefined); }
      const ctx = new AudioContext();
      ctxRef.current = ctx;
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      ctx.createMediaStreamSource(s).connect(an);
      const buf = new Uint8Array(an.fftSize);
      const loop = () => {
        an.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128) / 128);
        setLevel(l => Math.max(peak, l * 0.85));
        if (startedAt.current) setElapsed((performance.now() - startedAt.current) / 1000);
        raf.current = requestAnimationFrame(loop);
      };
      loop();
      setState('ready');
    } catch (e) {
      setError(m === 'cam' ? 'Нет доступа к камере. Проверьте, что она подключена и не занята другой программой.' : 'Нет доступа к микрофону. Проверьте, что он подключён, и разрешите доступ в настройках Windows (Конфиденциальность → Микрофон).');
      setState('idle');
    }
  };

  const start = () => {
    if (!stream.current) return;
    chunks.current = [];
    const mime = mode === 'cam' ? 'video/webm;codecs=vp9,opus' : 'audio/webm;codecs=opus';
    const r = new MediaRecorder(stream.current, MediaRecorder.isTypeSupported(mime) ? { mimeType: mime } : undefined);
    r.ondataavailable = e => { if (e.data.size) chunks.current.push(e.data); };
    r.onstop = async () => {
      setState('saving');
      startedAt.current = 0;
      try {
        const blob = new Blob(chunks.current, { type: r.mimeType });
        const path = await api.saveRecording(await blob.arrayBuffer(), 'webm');
        const at = get().playhead;
        const [m] = await A.importFiles([path]);
        if (m) {
          if (m.kind === 'audio') A.addToTimeline(m.id, 'audio', { start: at });
          else A.addToTimeline(m.id, 'main');
          toast('success', mode === 'cam' ? 'Видео с камеры добавлено' : 'Голос записан и добавлен на таймлайн', { detail: path });
        }
      } catch (e) {
        toast('error', 'Не удалось сохранить запись', { detail: String(e) });
      }
      setState('ready');
      setElapsed(0);
    };
    r.start(500);
    rec.current = r;
    startedAt.current = performance.now();
    set({ playing: mode === 'mic' });
    setState('rec');
  };
  const stop = () => { rec.current?.stop(); set({ playing: false }); };

  return (
    <>
      <div className="panel-head"><Mic size={16} /><h3>Запись</h3></div>
      <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Segmented value={mode} onChange={m => { setMode(m); if (state !== 'idle') prepare(m); }} options={[{ value: 'mic', label: <><Mic size={14} /> Голос</> }, { value: 'cam', label: <><Camera size={14} /> Камера</> }]} />
        <div className="tip-card">
          {mode === 'mic' ? <Mic size={18} color="var(--accent)" style={{ flex: 'none' }} /> : <Camera size={18} color="var(--accent)" style={{ flex: 'none' }} />}
          <div>{mode === 'mic'
            ? 'Запишите закадровый голос. Во время записи ролик проигрывается, чтобы вы говорили точно в такт. Запись встанет на звуковую дорожку с места линии времени.'
            : 'Запишите себя на камеру — видео встанет в конец ролика.'}</div>
        </div>
        {mode === 'cam' && <video ref={videoRef} muted playsInline style={{ width: '100%', aspectRatio: '16/9', background: '#000', borderRadius: 10, objectFit: 'cover', display: state === 'idle' ? 'none' : 'block' }} />}
        {state !== 'idle' && (
          <div>
            <div className="label" style={{ marginBottom: 6 }}>Громкость <span className="mono">{state === 'rec' ? formatTime(elapsed) : ''}</span></div>
            <div className="progress" style={{ width: '100%', height: 8 }}><div style={{ width: `${Math.min(100, level * 140)}%`, background: level > 0.9 ? 'var(--bad)' : undefined, transition: 'none' }} /></div>
            {level > 0.9 && <div className="small-text" style={{ color: 'var(--bad)', marginTop: 4 }}>Слишком громко — отодвиньтесь от микрофона</div>}
          </div>
        )}
        {error && <div className="warning-box"><TriangleAlert size={16} color="var(--warn)" /><div className="small-text">{error}</div></div>}
        {state === 'idle' && <button className="btn big" onClick={() => prepare()}>{mode === 'mic' ? <Mic size={17} /> : <Camera size={17} />} Включить {mode === 'mic' ? 'микрофон' : 'камеру'}</button>}
        {state === 'ready' && <button className="btn primary big" onClick={start}><span style={{ width: 12, height: 12, borderRadius: '50%', background: '#fff' }} /> Начать запись</button>}
        {state === 'rec' && <button className="btn danger big" onClick={stop}><Square size={15} fill="currentColor" /> Остановить ({formatTime(elapsed)})</button>}
        {state === 'saving' && <button className="btn big" disabled><span className="spinner" /> Сохраняю…</button>}
      </div>
    </>
  );
}

// ── ИИ-инструменты ───────────────────────────────────
function AiPanel() {
  const settings = useStore(s => s.settings);
  const secrets = useStore(s => s.secrets);
  const [db, setDb] = useState(-35);
  const [min, setMin] = useState(0.6);
  const preset = providerPreset(settings.ai.provider);
  const ready = !preset.needsKey || secrets[preset.id];
  const IDEAS = [
    'Сделай динамичный ролик: убери паузы, добавь переходы и музыку потише',
    'Добавь красивый заголовок в начало и подпись в конце',
    'Сделай вертикальную версию для Reels',
    'Подбери цвет, чтобы было как в кино',
    'Посмотри ролик и скажи, что улучшить',
  ];
  return (
    <>
      <div className="panel-head"><Sparkles size={16} /><h3>ИИ-инструменты</h3></div>
      <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="card">
          <div className="row"><Scissors size={16} color="var(--accent)" /><b>Убрать паузы</b></div>
          <div className="small-text muted">Находит молчание в речи и вырезает его. Работает без интернета.</div>
          <Slider label="Что считать тишиной" value={db} min={-60} max={-20} step={1} def={-35} unit=" дБ" onChange={setDb} hint={'Меньше — вырезается только полная тишина.\nБольше — и тихие звуки тоже.'} />
          <Slider label="Пауза длиннее" value={min} min={0.2} max={3} step={0.1} def={0.6} unit=" с" onChange={setMin} />
          <button className="btn primary" onClick={() => A.removeSilence({ db, min })}><Scissors size={14} /> Убрать паузы</button>
        </div>
        <div className="card">
          <div className="row"><Clapperboard size={16} color="var(--accent)" /><b>Разрезать по сценам</b></div>
          <div className="small-text muted">Находит места, где меняется картинка, и режет видео на части.</div>
          <button className="btn" onClick={() => {
            const p = get().project!;
            const main = mainTrack(p);
            const id = get().selection.find(i => main.clips.some(c => c.id === i)) || main.clips[0]?.id;
            if (!id) { toast('info', 'На основной дорожке нет видео'); return; }
            A.detectScenes(id).catch(e => toast('error', String(e.message || e)));
          }}><Scissors size={14} /> Найти сцены</button>
        </div>
        <div className="card">
          <div className="row"><Captions size={16} color="var(--accent)" /><b>Субтитры из речи</b></div>
          <div className="small-text muted">Нужен ключ OpenAI или Groq (распознавание речи). Язык: {settings.ai.speechLanguage || 'авто'}.</div>
          <button className="btn" onClick={() => A.transcribeProject({ addSubs: true }).catch(() => undefined)}><Captions size={14} /> Сделать субтитры</button>
        </div>
        <div className="card">
          <div className="row"><WandSparkles size={16} color="var(--accent)" /><b>Попросить помощника</b></div>
          {!ready && <div className="small-text" style={{ color: 'var(--warn)' }}>Сначала подключите нейросеть — это займёт минуту. <a style={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={() => set({ dialog: 'settings', settingsTab: 'ai' })}>Подключить</a></div>}
          <div className="quick">{IDEAS.map(i => <button key={i} className="chip" onClick={() => askAssistant(i, true)}>{i}</button>)}</div>
        </div>
      </div>
    </>
  );
}
