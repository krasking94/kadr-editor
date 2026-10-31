// Левая панель: медиатека, готовые тексты, переходы, фильтры, запись с микрофона и камеры, ИИ-инструменты.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Blend, Camera, Captions, Clapperboard, Film, FolderOpen, Image as ImageIcon, Layers, Mic, Music, Plus, Scissors,
  Sparkles, Square, Trash2, Type, Upload, Video, Wand2, WandSparkles, AudioLines, TriangleAlert, ImagePlus, Loader2, Speech, Volume2, Play,
  Smile, Monitor, Languages, ScrollText, FileDown, FileUp, Eraser, Smartphone, Mic2, Gauge, BookOpenText, Clapperboard as Director, Stamp,
} from 'lucide-react';
import { defaultBrand, type Brand } from '../../shared/settings';
import * as S from '../state/smart';
import * as MT from '../state/media-tools';
import { ScriptPanel, ShortsPanel } from './ScriptPanel';
import { EMOJI, SHAPES, SHAPE_COLORS, renderShape } from '../lib/stickers';
import { imageProvider, type Voice } from '../../shared/generators';
import { generate, cleanError, projectAspect, videoSourceImage, type GenKind } from '../state/generate';
import { api, mediaUrl } from '../api';
import type { MediaClip, MediaItem, TransitionType } from '../../shared/types';
import { COLOR_PRESETS, findClip, formatTime, mainTrack, projectDuration, TRANSITIONS } from '../../shared/timeline';
import { providerPreset } from '../../shared/providers';
import { get, set, toast, useStore } from '../state/store';
import * as A from '../state/actions';
import { askAssistant } from '../state/assistant';
import { TEXT_PRESETS } from '../lib/text-presets';
import { transitionFx } from '../lib/transition-fx';
import { DND_MEDIA, DND_TEXT } from '../lib/dnd';
import { openMenu, Segmented, Slider, Switch } from './ui';

export type RailTab = 'media' | 'script' | 'shorts' | 'text' | 'stickers' | 'transitions' | 'filters' | 'record' | 'create' | 'ai';

const RAIL: { id: RailTab; label: string; icon: typeof Film; tip: string }[] = [
  { id: 'media', label: 'Медиа', icon: Film, tip: 'Ваши видео, фото и музыка' },
  { id: 'script', label: 'Речь', icon: ScrollText, tip: 'Монтаж через текст: удалите слова — они вырежутся из видео' },
  { id: 'shorts', label: 'Shorts', icon: Smartphone, tip: 'Нарезка длинного видео на короткие вертикальные ролики' },
  { id: 'text', label: 'Текст', icon: Type, tip: 'Заголовки, подписи, субтитры' },
  { id: 'stickers', label: 'Стикеры', icon: Smile, tip: 'Эмодзи, стрелки, рамки и другие фигуры поверх видео' },
  { id: 'transitions', label: 'Переходы', icon: Blend, tip: 'Плавные склейки между клипами' },
  { id: 'filters', label: 'Фильтры', icon: Wand2, tip: 'Цвет и эффекты' },
  { id: 'record', label: 'Запись', icon: Mic, tip: 'Голос с микрофона или видео с камеры' },
  { id: 'create', label: 'Создать', icon: ImagePlus, tip: 'Нейросеть нарисует картинку, озвучит текст, сделает звук или музыку' },
  { id: 'ai', label: 'ИИ', icon: Sparkles, tip: 'Автоматический монтаж' },
];

export function LeftRail({ tab, onTab, right }: { tab: RailTab | null; onTab: (t: RailTab) => void; right?: boolean }) {
  return (
    <div className={"left-rail" + (right ? " on-right" : "")}>
      {RAIL.map(r => (
        <button key={r.id} className={'rail-btn' + (tab === r.id ? ' on' : '')} onClick={() => onTab(r.id)} data-tip={r.tip} data-tip-pos={right ? 'left' : 'right'}>
          <r.icon size={19} />{r.label}
        </button>
      ))}
    </div>
  );
}

export function SidePanel({ tab, width }: { tab: RailTab; width?: number }) {
  return (
    <div className="side-panel" key={tab} style={width ? { width } : undefined}>
      {tab === 'media' && <MediaPanel />}
      {tab === 'script' && <ScriptPanel />}
      {tab === 'shorts' && <ShortsPanel />}
      {tab === 'text' && <TextPanel />}
      {tab === 'stickers' && <StickersPanel />}
      {tab === 'transitions' && <TransitionsPanel />}
      {tab === 'filters' && <FiltersPanel />}
      {tab === 'record' && <RecordPanel />}
      {tab === 'create' && <CreatePanel />}
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
    ...(m.kind === 'video' && !m.missing ? [m.proxy
      ? { label: 'Убрать лёгкую копию', icon: <Gauge size={14} />, onClick: () => MT.dropProxy(m.id) }
      : { label: 'Сделать лёгкую копию (плавный просмотр)', icon: <Gauge size={14} />, onClick: () => MT.requestProxies([m.id]) }] : []),
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
        {m.proxy && <span className="proxy-badge" data-tip="Есть лёгкая копия: просмотр плавный, сохранится оригинал">540p</span>}
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
        <div className="section-title" style={{ marginTop: 16 }}>Готовые титры</div>
        <TitleTemplates />
        <div className="section-title">Готовые стили</div>
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
        <SubtitlesCard />
      </div>
    </>
  );
}

function TitleTemplates() {
  const raw = useStore(s => s.settings.brand);
  const b = { ...defaultBrand(), ...raw };
  return (
    <>
      <div className="tile-grid">
        {S.TITLE_TEMPLATES.map(t => (
          <button key={t.id} className="tile" data-tip={t.tip + '. Встанет с места линии времени, текст можно поменять справа'} onClick={() => { try { S.addTitleTemplate(t.id); } catch (e) { toast('error', 'Не получилось', { detail: String(e) }); } }}>
            <div className="t-prev tpl-prev" style={{ fontFamily: b.font }}>
              <TemplatePreview id={t.id} b={b} />
            </div>
            <span className="t-name">{t.name}</span>
          </button>
        ))}
      </div>
      <div className="card" style={{ gap: 8, marginTop: 10 }}>
        <div className="row"><Stamp size={15} color="var(--accent)" /><b>Бренд-кит</b><span className="spacer" />
          {[b.primary, b.accent, b.text].map((c, i) => <span key={i} style={{ width: 14, height: 14, borderRadius: 4, background: c, border: '1px solid var(--line-2)' }} />)}
        </div>
        <div className="small-text muted">{b.name ? `«${b.name}», шрифт ${b.font}.` : 'Свои цвета, шрифт и логотип.'} Титры выше уже берут цвета бренда.</div>
        <div className="row wrap" style={{ gap: 6 }}>
          <button className="btn small" disabled={!b.logo} data-tip={b.logo ? 'Логотип встанет в угол на весь ролик' : 'Сначала выберите логотип в настройках бренд-кита'} onClick={() => S.addBrandLogo().catch(e => toast('error', 'Не получилось', { detail: String(e) }))}>Логотип в угол</button>
          <button className="btn small" data-tip="Шрифт и цвета бренда — всем надписям проекта" onClick={() => { const n = S.applyBrandToTexts(); toast('success', n ? `Бренд применён к надписям: ${n}` : 'В проекте пока нет надписей'); }}>Ко всем надписям</button>
          <button className="btn small ghost" onClick={() => set({ dialog: 'settings', settingsTab: 'brand' })}>Настроить</button>
        </div>
      </div>
    </>
  );
}

function TemplatePreview({ id, b }: { id: string; b: Brand }) {
  const plate = (bg: string, color: string, size: number, text: string, extra: React.CSSProperties = {}) =>
    <span style={{ background: bg, color, fontSize: size, fontWeight: 700, padding: '1px 5px', lineHeight: 1.25, whiteSpace: 'nowrap', ...extra }}>{text}</span>;
  switch (id) {
    case 'lower-third': return <div style={{ position: 'absolute', left: 8, bottom: 8, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1 }}>{plate(b.primary, b.text, 11, 'Иван Петров')}{plate('#111318', '#fff', 8, 'основатель', { fontWeight: 400 })}</div>;
    case 'intro': return <div style={{ textAlign: 'center' }}><div style={{ fontFamily: 'Unbounded', fontWeight: 700, fontSize: 12, color: b.text }}>Как я построил</div>{plate(b.accent, '#111318', 8, 'ЗА 30 ДНЕЙ')}</div>;
    case 'subscribe': return <div style={{ textAlign: 'center' }}>{plate('#ff2d3d', '#fff', 10, '👆 ПОДПИШИСЬ')}</div>;
    case 'chapter': return <div style={{ textAlign: 'center', lineHeight: 1 }}><div style={{ fontFamily: 'Unbounded', fontSize: 20, fontWeight: 700, color: b.accent }}>01</div><div style={{ fontSize: 9, fontWeight: 700, color: b.text }}>ПОДГОТОВКА</div></div>;
    case 'sale': return <div style={{ textAlign: 'center', lineHeight: 1.1 }}><div style={{ fontFamily: 'Russo One', fontSize: 20, color: '#ffe14d', WebkitTextStroke: '1px #000' }}>−30%</div>{plate(b.primary, '#fff', 7, 'до воскресенья')}</div>;
    case 'question': return <div style={{ textAlign: 'center' }}><div style={{ fontSize: 10, fontWeight: 700, color: b.text, WebkitTextStroke: '0.5px #000' }}>А вы как думаете?</div>{plate(b.accent, '#111318', 7, 'Пишите 👇')}</div>;
    default: return <div style={{ textAlign: 'center' }}><div style={{ fontFamily: 'Unbounded', fontSize: 10, fontWeight: 700, color: b.text }}>Спасибо!</div>{plate(b.accent, '#111318', 7, b.name || '@канал')}</div>;
  }
}

const LANGS = ['English', 'Русский', 'Українська', 'Қазақша', 'Deutsch', 'Español', 'Français', 'Italiano', 'Português', 'Türkçe', '中文', '日本語', 'العربية', 'हिन्दी'];

function SubtitlesCard() {
  const [style, setStyle] = useState<'blogger' | 'classic'>('blogger');
  const [words, setWords] = useState(3);
  const [hl, setHl] = useState(S.HIGHLIGHTS[0]);
  const [lang, setLang] = useState('English');
  const busy = useStore(s => s.tasks.some(t => /субтитр|Распознаю|паразит|Перевожу/i.test(t.label)));
  return (
    <div className="card" style={{ gap: 10 }}>
      <div className="small-text muted">ИИ послушает речь в видео и сам расставит субтитры по времени.</div>
      <Segmented value={style} onChange={setStyle} options={[
        { value: 'blogger', label: 'Как у блогеров', tip: 'Крупно, по 2–4 слова, произносимое слово подсвечивается' },
        { value: 'classic', label: 'Классика', tip: 'Целые фразы внизу кадра на плашке' },
      ]} />
      {style === 'blogger' && <>
        <Slider label="Слов на экране" value={words} min={1} max={6} step={1} def={3} onChange={setWords} />
        <div className="row wrap" style={{ gap: 5 }}>
          <span className="small-text muted">Подсветка:</span>
          {S.HIGHLIGHTS.map(c => <button key={c} onClick={() => setHl(c)} style={{ width: 20, height: 20, borderRadius: 6, border: hl === c ? '2px solid var(--accent)' : '1px solid var(--line-2)', background: c, cursor: 'pointer' }} />)}
        </div>
      </>}
      <button className="btn primary small" disabled={busy} onClick={() => S.makeSubtitles({ style, words, highlight: hl }).catch(() => undefined)}><Captions size={13} /> Сделать субтитры</button>
      <div className="row" style={{ gap: 6 }}>
        <select className="input" value={lang} onChange={e => setLang(e.target.value)} style={{ flex: 1 }}>{LANGS.map(l => <option key={l}>{l}</option>)}</select>
        <button className="btn small" disabled={busy} onClick={() => S.translateSubtitles(lang).catch(() => undefined)} data-tip="Перевод делает нейросеть из настроек ИИ"><Languages size={13} /> Перевести</button>
      </div>
      <div className="row wrap" style={{ gap: 6 }}>
        <button className="btn small ghost" onClick={() => S.importSubtitles()} data-tip="Открыть готовые субтитры из файла .srt или .vtt"><FileUp size={13} /> Открыть SRT</button>
        <button className="btn small ghost" onClick={() => S.exportSubtitles()} data-tip="Файл для YouTube, ВК и плееров"><FileDown size={13} /> Сохранить SRT</button>
      </div>
    </div>
  );
}

// ── Стикеры и фигуры ─────────────────────────────────
function StickersPanel() {
  const [color, setColor] = useState(SHAPE_COLORS[0]);
  const previews = useMemo(() => Object.fromEntries(SHAPES.map(sh => [sh.id, renderShape(sh.id, color).dataUrl])), [color]);
  return (
    <>
      <div className="panel-head"><Smile size={16} /><h3>Стикеры</h3></div>
      <div className="panel-body">
        <div className="tip-card" style={{ marginBottom: 12 }}><Smile size={18} color="var(--accent)" style={{ flex: 'none' }} />
          <div>Нажмите — стикер встанет поверх видео с места линии времени на 3 секунды. Его можно двигать мышью прямо в кадре и растягивать на таймлайне.</div>
        </div>
        <div className="section-title" style={{ marginTop: 0 }}>Стрелки и фигуры</div>
        <div className="row wrap" style={{ gap: 5, marginBottom: 8 }}>
          {SHAPE_COLORS.map(c => <button key={c} onClick={() => setColor(c)} style={{ width: 22, height: 22, borderRadius: 6, border: color === c ? '2px solid var(--accent)' : '1px solid var(--line-2)', background: c, cursor: 'pointer' }} />)}
        </div>
        <div className="tile-grid">
          {SHAPES.map(sh => (
            <button key={sh.id} className="tile" onClick={() => S.addShape(sh.id, color).catch(e => toast('error', 'Не получилось', { detail: String(e) }))}>
              <div className="t-prev" style={{ background: 'repeating-conic-gradient(#2a2f45 0 25%, #222638 0 50%) 0 0 / 14px 14px' }}>
                <img src={previews[sh.id]} style={{ maxWidth: '80%', maxHeight: '80%' }} draggable={false} />
              </div>
              <span className="t-name">{sh.label}</span>
            </button>
          ))}
        </div>
        <div className="section-title">Эмодзи</div>
        <div className="emoji-grid">
          {EMOJI.map(e => <button key={e} className="emoji-btn" onClick={() => S.addEmoji(e)}>{e}</button>)}
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
        <button className="btn small" style={{ width: '100%', marginBottom: 6 }} data-tip={'Прозрачный слой над видео: его цвет и эффекты меняют всё, что под ним.\nУдобно покрасить сразу весь ролик или кусок из многих клипов'}
          onClick={() => S.addAdjustLayer().catch(e => toast('error', 'Не получилось', { detail: String(e) }))}><Layers size={14} /> Корректирующий слой</button>
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
type ScreenSource = { id: string; name: string; screen: boolean; thumb: string };

function RecordPanel() {
  const [mode, setMode] = useState<'mic' | 'cam' | 'screen'>('mic');
  const [sources, setSources] = useState<ScreenSource[] | null>(null);
  const [sysAudio, setSysAudio] = useState(true);
  const [withMic, setWithMic] = useState(true);
  const extra = useRef<MediaStream[]>([]);
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
    extra.current.forEach(s => s.getTracks().forEach(t => t.stop()));
    extra.current = [];
    ctxRef.current?.close().catch(() => undefined);
    ctxRef.current = null;
    setLevel(0);
  };
  useEffect(() => () => { rec.current?.state === 'recording' && rec.current.stop(); release(); }, []);

  // Запись экрана: сначала выбираем, что записывать
  const [listing, setListing] = useState(false);
  const listScreens = async () => {
    release();
    setError('');
    setListing(true);
    try { setSources(await api.screenSources()); setState('idle'); } catch { setError('Не удалось получить список экранов.'); } finally { setListing(false); }
  };

  const prepare = async (m = mode, screenId?: string) => {
    release();
    setError('');
    try {
      let s: MediaStream;
      const ctx = new AudioContext();
      ctxRef.current = ctx;
      if (m === 'screen') {
        await api.chooseScreen(screenId, sysAudio);
        const disp = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: sysAudio });
        extra.current.push(disp);
        // звук компьютера и микрофон сводим в одну дорожку
        const dest = ctx.createMediaStreamDestination();
        if (disp.getAudioTracks().length) ctx.createMediaStreamSource(new MediaStream(disp.getAudioTracks())).connect(dest);
        if (withMic) {
          try {
            const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
            extra.current.push(mic);
            ctx.createMediaStreamSource(mic).connect(dest);
          } catch { toast('warn', 'Микрофон недоступен — запишу без голоса'); }
        }
        s = new MediaStream([...disp.getVideoTracks(), ...dest.stream.getAudioTracks()]);
        disp.getVideoTracks()[0]?.addEventListener('ended', () => { if (rec.current?.state === 'recording') rec.current.stop(); });
        setSources(null);
      } else {
        s = await navigator.mediaDevices.getUserMedia(m === 'cam' ? { audio: true, video: { width: 1920, height: 1080 } } : { audio: { echoCancellation: true, noiseSuppression: true } });
      }
      stream.current = s;
      if (m !== 'mic' && videoRef.current) { videoRef.current.srcObject = s; videoRef.current.play().catch(() => undefined); }
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      if (s.getAudioTracks().length) ctx.createMediaStreamSource(s).connect(an);
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
      setError(m === 'screen' ? 'Не удалось начать запись экрана. Попробуйте выбрать другое окно.' : m === 'cam' ? 'Нет доступа к камере. Проверьте, что она подключена и не занята другой программой.' : 'Нет доступа к микрофону. Проверьте, что он подключён, и разрешите доступ в настройках Windows (Конфиденциальность → Микрофон).');
      setState('idle');
    }
  };

  const start = () => {
    if (!stream.current) return;
    chunks.current = [];
    const mime = mode !== 'mic' ? 'video/webm;codecs=vp9,opus' : 'audio/webm;codecs=opus';
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
          toast('success', mode === 'screen' ? 'Запись экрана добавлена в ролик' : mode === 'cam' ? 'Видео с камеры добавлено' : 'Голос записан и добавлен на таймлайн', { detail: path });
          if (mode === 'screen') api.restore();
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
    if (mode === 'screen') toast('info', 'Идёт запись экрана', { detail: 'Сверните «Хлопушка». Чтобы закончить, вернитесь и нажмите «Остановить».', ttl: 6000 });
  };
  const stop = () => { rec.current?.stop(); set({ playing: false }); };

  return (
    <>
      <div className="panel-head"><Mic size={16} /><h3>Запись</h3></div>
      <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Segmented value={mode} onChange={m => { setMode(m); setSources(null); if (state !== 'idle') { if (m === 'screen') { release(); setState('idle'); } else prepare(m); } }} options={[
          { value: 'mic', label: <><Mic size={14} /> Голос</> }, { value: 'cam', label: <><Camera size={14} /> Камера</> }, { value: 'screen', label: <><Monitor size={14} /> Экран</> }]} />
        <div className="tip-card">
          {mode === 'mic' ? <Mic size={18} color="var(--accent)" style={{ flex: 'none' }} /> : mode === 'cam' ? <Camera size={18} color="var(--accent)" style={{ flex: 'none' }} /> : <Monitor size={18} color="var(--accent)" style={{ flex: 'none' }} />}
          <div>{mode === 'mic'
            ? 'Запишите закадровый голос. Во время записи ролик проигрывается, чтобы вы говорили точно в такт. Запись встанет на звуковую дорожку с места линии времени.'
            : mode === 'cam' ? 'Запишите себя на камеру — видео встанет в конец ролика.'
              : 'Запишите экран или окно программы: для уроков, обзоров и инструкций. Можно сразу говорить в микрофон. Во время записи сверните «Хлопушка», а потом вернитесь и нажмите «Остановить».'}</div>
        </div>
        {mode === 'screen' && state === 'idle' && !sources && <>
          <Switch label="Звук компьютера" checked={sysAudio} onChange={setSysAudio} hint="Всё, что слышно в колонках: видео, игра, звонок" />
          <Switch label="Мой голос (микрофон)" checked={withMic} onChange={setWithMic} />
        </>}
        {sources && (
          <div className="screen-grid">
            {sources.map(src => (
              <button key={src.id} className="tile" onClick={() => prepare('screen', src.id)}>
                <div className="t-prev" style={{ backgroundImage: `url("${src.thumb}")`, backgroundSize: 'cover', backgroundPosition: 'center' }} />
                <span className="t-name">{src.screen ? <Monitor size={11} style={{ verticalAlign: -1 }} /> : null} {src.name}</span>
              </button>
            ))}
          </div>
        )}
        {mode !== 'mic' && <video ref={videoRef} muted playsInline style={{ width: '100%', aspectRatio: '16/9', background: '#000', borderRadius: 10, objectFit: mode === 'screen' ? 'contain' : 'cover', display: state === 'idle' ? 'none' : 'block' }} />}
        {state !== 'idle' && (
          <div>
            <div className="label" style={{ marginBottom: 6 }}>Громкость <span className="mono">{state === 'rec' ? formatTime(elapsed) : ''}</span></div>
            <div className="progress" style={{ width: '100%', height: 8 }}><div style={{ width: `${Math.min(100, level * 140)}%`, background: level > 0.9 ? 'var(--bad)' : undefined, transition: 'none' }} /></div>
            {level > 0.9 && <div className="small-text" style={{ color: 'var(--bad)', marginTop: 4 }}>Слишком громко — отодвиньтесь от микрофона</div>}
          </div>
        )}
        {error && <div className="warning-box"><TriangleAlert size={16} color="var(--warn)" /><div className="small-text">{error}</div></div>}
        {state === 'idle' && mode !== 'screen' && <button className="btn big" onClick={() => prepare()}>{mode === 'mic' ? <Mic size={17} /> : <Camera size={17} />} Включить {mode === 'mic' ? 'микрофон' : 'камеру'}</button>}
        {state === 'idle' && mode === 'screen' && !sources && <button className="btn big" disabled={listing} onClick={listScreens}><Monitor size={17} /> {listing ? 'Ищу экраны и окна…' : 'Выбрать, что записывать'}</button>}
        {sources && <button className="btn small ghost" onClick={() => setSources(null)}>Отмена</button>}
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
  const [loud, setLoud] = useState<{ lufs: number; peak: number } | null>(null);
  const [busy, setBusy] = useState('');
  const run = (key: string, fn: () => Promise<unknown>) => { setBusy(key); fn().catch(e => { if (String(e?.message || e) !== 'Отменено') toast('error', String(e?.message || e)); }).finally(() => setBusy('')); };
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
        <BeatsCard />
        <div className="card">
          <div className="row"><Captions size={16} color="var(--accent)" /><b>Субтитры из речи</b></div>
          <div className="small-text muted">Нужен ключ OpenAI или Groq (распознавание речи). Язык: {settings.ai.speechLanguage || 'авто'}.</div>
          <button className="btn" onClick={() => A.transcribeProject({ addSubs: true }).catch(() => undefined)}><Captions size={14} /> Сделать субтитры</button>
        </div>
        <div className="card">
          <div className="row"><Eraser size={16} color="var(--accent)" /><b>Убрать «эээ» и слова-паразиты</b></div>
          <div className="small-text muted">Находит «эээ», «ммм», «как бы», «короче» и вырезает их из речи. Нужен ключ для распознавания речи.</div>
          <button className="btn" disabled={busy === 'fill'} onClick={() => run('fill', () => S.removeFillers({ confirm: true }))}><Eraser size={14} /> {busy === 'fill' ? 'Ищу…' : 'Найти и убрать'}</button>
        </div>
        <div className="card">
          <div className="row"><Smartphone size={16} color="var(--accent)" /><b>Вертикальное видео с лицом в центре</b></div>
          <div className="small-text muted">Делает кадр 9:16 для Reels, Shorts и TikTok, а «камера» сама следит за лицом. Работает без интернета.</div>
          <button className="btn" disabled={busy === 'vert'} onClick={() => run('vert', async () => {
            const r = await S.autoReframe();
            toast('success', 'Готово: вертикальный кадр', { detail: r.faces ? `Лицо найдено в ${r.clips} клип(ах)` : 'Лиц не нашлось — кадр по центру' });
          })}><Smartphone size={14} /> {busy === 'vert' ? 'Ищу лица…' : 'Сделать вертикальное'}</button>
        </div>
        <div className="card">
          <div className="row"><Mic2 size={16} color="var(--accent)" /><b>Студийный звук и громкость</b></div>
          <div className="small-text muted">Убирает шум и делает голос чистым и плотным, как в студии. Громкость при сохранении подгоняется под соцсети.</div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn" onClick={() => { const n = S.studioVoiceAll(true); toast(n ? 'success' : 'info', n ? `Студийный голос включён для ${n} клип(ов)` : 'В ролике нет клипов со звуком'); }}><Mic2 size={14} /> Включить для всех</button>
            <button className="btn ghost" disabled={busy === 'loud'} onClick={() => run('loud', async () => setLoud(await S.analyzeLoudness()))}><Gauge size={14} /> {busy === 'loud' ? 'Слушаю…' : 'Измерить громкость'}</button>
          </div>
          {loud && <div className="small-text">Сейчас {loud.lufs.toFixed(1)} LUFS — {S.loudnessVerdict(loud.lufs)}. При сохранении станет {settings.loudness} LUFS.</div>}
        </div>
        <div className="card">
          <div className="row"><Director size={16} color="var(--accent)" /><b>ИИ-режиссёр</b></div>
          <div className="small-text muted">Помощник смотрит ролик и советует, что улучшить, или пишет главы, описание и хэштеги.</div>
          <div className="quick">
            <button className="chip" onClick={() => askAssistant(S.DIRECTOR_PROMPT, true)}><Director size={12} /> Разбор ролика</button>
            <button className="chip" onClick={() => askAssistant(S.CHAPTERS_PROMPT)}><BookOpenText size={12} /> Главы, описание, хэштеги</button>
          </div>
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

function BeatsCard() {
  const [every, setEvery] = useState<'1' | '2' | '4'>('2');
  const busy = useStore(s => s.tasks.some(t => t.label === 'Ищу ритм в музыке'));
  return (
    <div className="card">
      <div className="row"><Music size={16} color="var(--accent)" /><b>Склейка под ритм музыки</b></div>
      <div className="small-text muted">Находит удары в музыке и подрезает клипы так, чтобы каждая смена кадра попадала в такт. Работает без интернета.</div>
      <div className="label">Менять кадр</div>
      <Segmented value={every} onChange={setEvery} options={[
        { value: '1', label: 'Каждый удар', tip: 'Быстрый, динамичный монтаж' },
        { value: '2', label: 'Через удар' },
        { value: '4', label: 'Каждый такт', tip: 'Спокойный монтаж, раз в 4 удара' },
      ]} />
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button className="btn primary" disabled={busy} onClick={() => MT.cutToBeats(Number(every))}><Scissors size={14} /> Подрезать под ритм</button>
        <button className="btn ghost" disabled={busy} onClick={() => MT.beatMarkers(Number(every)).then(n => n && toast('success', `Меток на долях: ${n}`))}>Только метки</button>
      </div>
    </div>
  );
}

// ── Создать нейросетью ───────────────────────────────
const KINDS: { value: GenKind; label: string; icon: typeof Film; placeholder: string; ideas: string[] }[] = [
  { value: 'image', label: 'Картинка', icon: ImagePlus, placeholder: 'Что нарисовать? Например: уютная кофейня осенью, тёплый свет, вид из окна',
    ideas: ['Обложка в стиле кино: город ночью, неон, дождь', 'Фон для заставки: мягкий градиент, абстракция', 'Иллюстрация в стиле акварели: лес на рассвете'] },
  { value: 'speech', label: 'Голос', icon: Speech, placeholder: 'Текст, который нужно прочитать вслух',
    ideas: ['Привет! Сегодня я покажу, как сделать это за пять минут.', 'Подписывайтесь, чтобы не пропустить новые видео!'] },
  { value: 'sfx', label: 'Звук', icon: Volume2, placeholder: 'Какой звук нужен? Лучше по-английски: whoosh transition, applause, camera shutter',
    ideas: ['Whoosh transition', 'Crowd applause', 'Camera shutter click', 'Notification ding'] },
  { value: 'music', label: 'Музыка', icon: Music, placeholder: 'Какая музыка? Жанр, настроение, темп, инструменты',
    ideas: ['Спокойный лоу-фай с пианино для влога', 'Энергичный электро-поп для рекламы', 'Эпичная оркестровая музыка для трейлера'] },
  { value: 'video', label: 'Видео', icon: Clapperboard, placeholder: 'Что должно происходить в ролике? Например: камера медленно облетает чашку кофе на деревянном столе, утренний свет',
    ideas: ['Медленный пролёт над осенним лесом на рассвете', 'Кот в очках читает газету в кафе, мультяшный стиль', 'Человек на фото улыбается и машет рукой'] },
];

let voicesCache: Voice[] | null = null;

function CreatePanel() {
  const settings = useStore(s => s.settings);
  const secrets = useStore(s => s.secrets);
  const project = useStore(s => s.project);
  const [kind, setKind] = useState<GenKind>('image');
  const [prompts, setPrompts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<GenKind | null>(null);
  const [place, setPlace] = useState<'main' | 'overlay' | 'none'>('main');
  const [imgDur, setImgDur] = useState(4);
  const [zoom, setZoom] = useState(true);
  const [sfxDur, setSfxDur] = useState(0);
  const projLen = Math.min(300, Math.max(10, Math.ceil(project ? projectDuration(project) : 30)));
  const [musicDur, setMusicDur] = useState(0);
  const [vocals, setVocals] = useState(false);
  const [volume, setVolume] = useState(0.35);
  const [voices, setVoices] = useState<Voice[]>(voicesCache || []);
  const [voiceId, setVoiceId] = useState(settings.gen.voiceId);
  const k = KINDS.find(x => x.value === kind)!;
  const prompt = prompts[kind] || '';
  const ip = imageProvider(settings.gen.imageProvider);
  const keyOk = kind === 'image' ? (ip.id === 'custom-image' || !!secrets[ip.keyId]) : kind === 'video' ? !!secrets.fal : !!secrets.elevenlabs;
  const [vMode, setVMode] = useState<'text' | 'photo'>('text');
  const [vDur, setVDur] = useState(settings.gen.videoDuration || 5);
  useEffect(() => {
    if (kind === 'speech' && secrets.elevenlabs && !voicesCache) api.genVoices().then((v: Voice[]) => { voicesCache = v; setVoices(v); }).catch(() => undefined);
  }, [kind, !!secrets.elevenlabs]);
  const run = async () => {
    if ((!prompt.trim() && !(kind === 'video' && vMode === 'photo')) || busy) return;
    setBusy(kind);
    try {
      if (kind === 'video') {
        const img = vMode === 'photo' ? await videoSourceImage() : null;
        if (vMode === 'photo' && !img) { toast('info', 'Нечего оживлять', { detail: 'Выберите фото на таймлайне или поставьте курсор на нужный кадр.' }); setBusy(null); return; }
        if (img) toast('info', `Оживляю ${img.label === 'кадр под курсором' ? 'кадр под курсором' : `«${img.label}»`}`, { detail: 'Обычно это занимает 1–5 минут. Можно продолжать монтаж.' });
        await generate({ kind, prompt: prompt.trim(), image: img?.path, duration: vDur, place: place === 'none' ? 'none' : place });
        setBusy(null);
        return;
      }
      await generate({
        kind, prompt: prompt.trim(),
        ...(kind === 'image' ? { place, duration: imgDur, animate: place === 'main' && zoom } : {}),
        ...(kind === 'speech' ? { voiceId: voiceId || undefined } : {}),
        ...(kind === 'sfx' ? { duration: sfxDur || undefined } : {}),
        ...(kind === 'music' ? { duration: musicDur || projLen, vocals, volume } : {}),
      });
    } catch (e) {
      toast('error', 'Не получилось', { detail: cleanError(e) });
    }
    setBusy(null);
  };
  const service = kind === 'image' ? ip.label : kind === 'video' ? 'fal.ai' : 'ElevenLabs';
  return (
    <>
      <div className="panel-head"><ImagePlus size={16} /><h3>Создать нейросетью</h3></div>
      <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="gen-kinds">
          {KINDS.map(x => (
            <button key={x.value} className={'gen-kind' + (kind === x.value ? ' on' : '')} onClick={() => setKind(x.value)}>
              {busy === x.value ? <Loader2 size={18} className="spin" /> : <x.icon size={18} />}{x.label}
            </button>
          ))}
        </div>
        <div className="card">
          <textarea className="input" rows={4} value={prompt} placeholder={k.placeholder}
            onChange={e => setPrompts({ ...prompts, [kind]: e.target.value })}
            onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) run(); }} />
          <div className="quick">{k.ideas.map(i => <button key={i} className="chip" onClick={() => setPrompts({ ...prompts, [kind]: i })}>{i}</button>)}</div>
          {kind === 'image' && <>
            <Segmented value={place} onChange={setPlace} options={[
              { value: 'main', label: 'В ролик', tip: 'В конец основной дорожки' },
              { value: 'overlay', label: 'Поверх', tip: 'Картинка в картинке с места курсора' },
              { value: 'none', label: 'В файлы', tip: 'Сохранить в медиатеку, на таймлайн не ставить' },
            ]} />
            {place !== 'none' && <Slider label="Сколько показывать" value={imgDur} min={1} max={15} step={0.5} def={4} unit=" с" onChange={setImgDur} />}
            {place === 'main' && <Switch checked={zoom} onChange={setZoom} label="Плавное приближение (оживить картинку)" />}
            <div className="small-text muted">Пропорции: {settings.gen.imageAspect === 'auto' ? `как у проекта (${projectAspect()})` : settings.gen.imageAspect}</div>
          </>}
          {kind === 'speech' && (
            <div className="row">
              <select className="input" value={voiceId} onChange={e => setVoiceId(e.target.value)}>
                <option value="">{settings.gen.voiceName ? `Голос из настроек: ${settings.gen.voiceName}` : 'Голос по умолчанию'}</option>
                {voices.map(v => <option key={v.id} value={v.id}>{v.name}{v.info ? ` — ${v.info}` : ''}</option>)}
              </select>
              <button className="icon-btn" data-tip="Послушать голос" disabled={!voices.find(v => v.id === voiceId)?.preview}
                onClick={() => { const u = voices.find(v => v.id === voiceId)?.preview; if (u) new Audio(u).play().catch(() => undefined); }}><Play size={14} /></button>
            </div>
          )}
          {kind === 'speech' && <div className="small-text muted">Озвучка встанет на звуковую дорожку с места курсора.</div>}
          {kind === 'video' && <>
            <Segmented value={vMode} onChange={setVMode} options={[
              { value: 'text', label: 'По описанию', tip: 'Нейросеть снимет ролик с нуля по вашему тексту' },
              { value: 'photo', label: 'Оживить фото', tip: 'Выбранное на таймлайне фото (или кадр под курсором) начнёт двигаться' },
            ]} />
            <div className="row" style={{ gap: 6 }}>
              <span className="small-text muted">Длина:</span>
              {[5, 10].map(d => <button key={d} className="chip" onClick={() => setVDur(d)} style={vDur === d ? { borderColor: 'var(--accent)', color: 'var(--text)', background: 'var(--accent-soft)' } : undefined}>{d} с</button>)}
            </div>
            <Segmented value={place} onChange={setPlace} options={[
              { value: 'main', label: 'В ролик', tip: 'В конец основной дорожки' },
              { value: 'overlay', label: 'Поверх', tip: 'Картинка в картинке с места курсора' },
              { value: 'none', label: 'В файлы', tip: 'Сохранить в медиатеку' },
            ]} />
            <div className="small-text muted">{vMode === 'photo' ? 'Опишите движение: «улыбается и машет», «камера наезжает». ' : ''}Видео снимается 1–5 минут и стоит примерно 20–150 ₽ за ролик (зависит от модели). Пропорции — как у проекта ({projectAspect()}).</div>
          </>}
          {kind === 'sfx' && <Slider label="Длительность" value={sfxDur} min={0} max={30} step={0.5} def={0} unit=" с" format={v => (v ? v + ' с' : 'авто')} onChange={setSfxDur} />}
          {kind === 'music' && <>
            <Slider label="Длительность" value={musicDur || projLen} min={10} max={300} step={5} def={projLen} unit=" с" onChange={setMusicDur} />
            <Slider label="Громкость" value={volume} min={0} max={1} step={0.05} def={0.35} format={v => Math.round(v * 100) + ' %'} onChange={setVolume} />
            <Switch checked={vocals} onChange={setVocals} label="С вокалом (песня)" />
            <div className="small-text muted">Музыка встанет с начала ролика и сама станет тише, когда говорят.</div>
          </>}
          {!keyOk && <div className="small-text" style={{ color: 'var(--warn)' }}>Нужен ключ «{service}». <a style={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={() => set({ dialog: 'settings', settingsTab: 'gen' })}>Вставить ключ</a></div>}
          <button className="btn primary" disabled={(!prompt.trim() && !(kind === 'video' && vMode === 'photo')) || !!busy || !project} onClick={run}>
            {busy === kind ? <><Loader2 size={14} className="spin" /> {kind === 'music' ? 'Пишу музыку, до минуты…' : kind === 'video' ? 'Снимаю, 1–5 минут…' : 'Создаю…'}</> : <><WandSparkles size={14} /> Создать</>}
          </button>
          <div className="small-text muted" style={{ textAlign: 'center' }}>{service} · <a style={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={() => set({ dialog: 'settings', settingsTab: 'gen' })}>настройки</a> · Ctrl+Enter</div>
        </div>
        <div className="tip-card"><Sparkles size={16} color="var(--accent)" style={{ flex: 'none' }} />
          <div className="small-text">Можно попросить ИИ-помощника или Claude: «нарисуй заставку, озвучь текст и подложи спокойную музыку» — он сделает всё сам.</div>
        </div>
      </div>
    </>
  );
}
