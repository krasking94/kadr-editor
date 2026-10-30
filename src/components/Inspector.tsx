// Правая панель: настройки того, что выбрано. Ничего не выбрано — настройки всего проекта.
import { useEffect, useState } from 'react';
import {
  AlignCenter, AlignLeft, AlignRight, AudioLines, Bold, CaseUpper, Clapperboard, Film, Gauge, Image as ImageIcon, Italic, Lightbulb,
  Move, Music, Palette, RotateCcw, Scissors, SlidersHorizontal, Snowflake, Sparkles, Trash2, Type, Volume2, Blend,
  Vibrate, Rewind, Undo2, ScanFace, Pipette, FileImage, Mic2, Headphones, Highlighter, Diamond, ChevronLeft, ChevronRight, X,
} from 'lucide-react';
import { mediaUrl } from '../api';
import type { MediaClip, MediaItem, TextAnim, TextClip, TransitionType } from '../../shared/types';
import {
  clipDuration, COLOR_PRESETS, defaultColor, defaultEffects, defaultTransform, findClip, FORMAT_PRESETS, formatTime, mainTrack,
  projectDuration, TEXT_ANIMS, TRANSITIONS, transformAt,
} from '../../shared/timeline';
import { commit, set, useStore } from '../state/store';
import * as A from '../state/actions';
import * as S from '../state/smart';
import { api } from '../api';
import { FONTS } from '../lib/fonts';
import { keysOf, prettyKeys } from '../lib/commands';
import { keysOf as clipKeys, KEY_SNAP, removeKey, setKeyAt } from '../../shared/keyframes';
import { ColorInput, Segmented, Slider, Switch } from './ui';

export function Inspector() {
  const project = useStore(s => s.project)!;
  const selection = useStore(s => s.selection);
  const found = selection.length === 1 ? findClip(project, selection[0]) : null;
  let body: React.ReactNode;
  if (selection.length > 1) body = <MultiInspector ids={selection} />;
  else if (found?.clip.type === 'media') body = <MediaInspector key={found.clip.id} clip={found.clip} trackKind={found.track.kind} index={found.index} />;
  else if (found?.clip.type === 'text') body = <TextInspector key={found.clip.id} clip={found.clip} />;
  else body = <ProjectInspector />;
  return <div className="inspector">{body}</div>;
}

function Tabs({ tabs, value, onChange }: { tabs: { id: string; label: string; icon: typeof Film }[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="tabs">
      {tabs.map(t => <button key={t.id} className={value === t.id ? 'on' : ''} onClick={() => onChange(t.id)}><t.icon size={13} />{t.label}</button>)}
    </div>
  );
}

function useTab(ids: string[]) {
  const tab = useStore(s => s.inspectorTab);
  const current = ids.includes(tab) ? tab : ids[0];
  return [current, (v: string) => set({ inspectorTab: v })] as const;
}

// ── Проект ───────────────────────────────────────────
function ProjectInspector() {
  const p = useStore(s => s.project)!;
  const [w, setW] = useState(p.width);
  const [h, setH] = useState(p.height);
  useEffect(() => { setW(p.width); setH(p.height); }, [p.width, p.height]);
  const clips = p.tracks.reduce((a, t) => a + t.clips.length, 0);
  return (
    <>
      <div className="panel-head"><Clapperboard size={16} /><h3>Проект</h3></div>
      <div className="panel-body" style={{ padding: 0 }}>
        <div className="insp-section">
          <h4>Формат кадра</h4>
          <div className="choice-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
            {FORMAT_PRESETS.map(f => (
              <button key={f.id} className={'choice' + (p.width === f.width && p.height === f.height ? ' on' : '')} onClick={() => A.applyFormatPreset(f.id)} style={{ padding: 9 }}>
                <b style={{ fontSize: 12 }}>{f.label}</b><small>{f.hint}</small>
              </button>
            ))}
          </div>
          <div className="row">
            <input className="input" type="number" value={w} onChange={e => setW(Number(e.target.value))} data-tip="Ширина" />
            <span className="muted">×</span>
            <input className="input" type="number" value={h} onChange={e => setH(Number(e.target.value))} data-tip="Высота" />
            <button className="btn small" disabled={w === p.width && h === p.height} onClick={() => A.setProjectFormat(Math.max(16, Math.round(w / 2) * 2), Math.max(16, Math.round(h / 2) * 2))}>OK</button>
          </div>
        </div>
        <div className="insp-section">
          <h4>Кадров в секунду</h4>
          <Segmented value={String(p.fps)} onChange={v => commit(`Частота ${v} кадр/с`, pr => { pr.fps = Number(v); })}
            options={['24', '25', '30', '50', '60'].map(v => ({ value: v, label: v, tip: v === '24' ? 'Как в кино' : v === '30' ? 'Обычное видео' : v === '60' ? 'Плавно, для игр и спорта' : undefined }))} />
          <ColorInput label="Цвет фона" value={p.background} onChange={v => commit('Цвет фона', pr => { pr.background = v; }, { coalesce: 'bg' })} />
        </div>
        <div className="insp-section">
          <h4>Сводка</h4>
          <div className="row" style={{ justifyContent: 'space-between' }}><span className="muted">Длина ролика</span><b className="mono">{formatTime(projectDuration(p), p.fps, true)}</b></div>
          <div className="row" style={{ justifyContent: 'space-between' }}><span className="muted">Клипов</span><b>{clips}</b></div>
          <div className="row" style={{ justifyContent: 'space-between' }}><span className="muted">Файлов</span><b>{p.media.length}</b></div>
        </div>
        <div className="insp-section" style={{ borderBottom: 0 }}>
          <div className="tip-card"><Lightbulb size={18} color="var(--accent)" style={{ flex: 'none' }} />
            <div>
              Щёлкните по клипу на таймлайне — здесь появятся его настройки.<br />
              <b>Пробел</b> — смотреть, <b>S</b> — разрезать, <b>Ctrl+Z</b> — отменить, <b>{prettyKeys(keysOf('palette'))}</b> — все команды.
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Несколько клипов ─────────────────────────────────
function MultiInspector({ ids }: { ids: string[] }) {
  const p = useStore(s => s.project)!;
  const media = ids.map(id => findClip(p, id)?.clip).filter((c): c is MediaClip => c?.type === 'media');
  return (
    <>
      <div className="panel-head"><SlidersHorizontal size={16} /><h3>Выбрано: {ids.length}</h3></div>
      <div className="panel-body" style={{ padding: 0 }}>
        {media.length > 0 && (
          <div className="insp-section">
            <h4>Цвет для всех</h4>
            <div className="preset-grid">
              {Object.entries(COLOR_PRESETS).map(([id, pr]) => (
                <button key={id} className="preset" onClick={() => media.forEach(c => A.updateMediaClip(c.id, { color: { preset: id as MediaClip['color']['preset'] } }, `Фильтр «${pr.label}»`, { coalesce: '' }))}>
                  <div className="p-img" style={{ background: 'linear-gradient(135deg,#ff9a3d,#ff5c8a 40%,#7c5cff 70%,#2bd4c5)', filter: pr.css || undefined }} /><span>{pr.label}</span>
                </button>
              ))}
            </div>
            <Slider label="Громкость для всех" value={media[0].volume} min={0} max={2} step={0.01} def={1} format={v => Math.round(v * 100) + '%'}
              onChange={v => media.forEach(c => A.updateMediaClip(c.id, { volume: v }, 'Громкость', { coalesce: 'multi-vol' }))} />
          </div>
        )}
        <div className="insp-section">
          <div className="row wrap">
            <button className="btn small" onClick={() => A.duplicateClips(ids)}>Дублировать</button>
            <button className="btn small danger" onClick={() => A.deleteClips(ids)}><Trash2 size={13} /> Удалить все</button>
          </div>
          <div className="small-text muted">Ctrl+щелчок по клипу — добавить или убрать из выбора.</div>
        </div>
      </div>
    </>
  );
}

// ── Видео, фото, звук ────────────────────────────────
function ClipSummary({ media, sub, thumb }: { media?: MediaItem; sub: string; thumb?: string }) {
  const Icon = media?.kind === 'audio' ? Music : media?.kind === 'image' ? ImageIcon : Film;
  return (
    <div className="clip-summary">
      <div className="thumb" style={{ backgroundImage: thumb ? `url("${mediaUrl(thumb)}")` : undefined }}>{!thumb && <Icon size={18} color="var(--muted)" />}</div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{media?.name || 'Клип'}</div>
        <div className="small-text muted">{sub}</div>
      </div>
    </div>
  );
}

function MediaInspector({ clip, trackKind, index }: { clip: MediaClip; trackKind: string; index: number }) {
  const project = useStore(s => s.project)!;
  const cache = useStore(s => s.mediaCache);
  const m = project.media.find(x => x.id === clip.mediaId);
  const thumb = m ? cache[m.id]?.thumb : undefined;
  const isAudio = m?.kind === 'audio';
  const tabs = isAudio
    ? [{ id: 'audio', label: 'Звук', icon: Volume2 }]
    : [{ id: 'main', label: 'Основное', icon: SlidersHorizontal }, { id: 'color', label: 'Цвет', icon: Palette }, { id: 'fx', label: 'Эффекты', icon: Sparkles }, { id: 'motion', label: 'Движение', icon: Move }, ...(m?.hasAudio ? [{ id: 'audio', label: 'Звук', icon: Volume2 }] : [])];
  const [tab, setTab] = useTab(tabs.map(t => t.id));
  const up = (patch: A.MediaClipPatch, label: string, key?: string) => A.updateMediaClip(clip.id, patch, label, key === undefined ? {} : { coalesce: key });
  const main = mainTrack(project);
  const prev = trackKind === 'main' && index > 0 ? main.clips[index - 1] : null;
  const where = trackKind === 'main' ? 'основное видео' : trackKind === 'video' ? 'наложение' : 'звук';
  // с ключевыми кадрами ползунки показывают, где клип сейчас, под курсором
  const playhead = useStore(s => (clip.keys?.length ? s.playhead : 0));
  const tr = clip.keys?.length ? transformAt(clip, playhead - clip.start) : clip.transform;

  return (
    <>
      <ClipSummary media={m} thumb={thumb} sub={`${formatTime(clipDuration(clip), project.fps, true)} · ${where}${clip.speed !== 1 ? ` · ×${clip.speed}` : ''}`} />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      <div className="panel-body" style={{ padding: 0 }}>
        {tab === 'main' && (
          <>
            <div className="insp-section">
              <h4><Gauge size={14} /> Скорость</h4>
              <div className="row wrap" style={{ gap: 5 }}>
                {[0.25, 0.5, 1, 1.5, 2, 4].map(sp => <button key={sp} className={'chip' + (clip.speed === sp ? ' on' : '')} style={clip.speed === sp ? { borderColor: 'var(--accent)', color: 'var(--text)', background: 'var(--accent-soft)' } : undefined} onClick={() => up({ speed: sp }, `Скорость ×${sp}`, '')}>×{sp}</button>)}
              </div>
              <Slider label="Точно" value={clip.speed} min={0.1} max={8} step={0.05} def={1} format={v => '×' + v.toFixed(2)} onChange={v => up({ speed: v }, 'Скорость клипа')} />
            </div>
            {trackKind === 'main' && (
              <div className="insp-section">
                <h4><Blend size={14} /> Переход перед клипом</h4>
                {prev ? (
                  <>
                    <select className="input" value={clip.transition?.type || 'none'} onChange={e => A.setTransition(clip.id, e.target.value as TransitionType | 'none', clip.transition?.duration ?? 0.6)}>
                      <option value="none">Без перехода</option>
                      {TRANSITIONS.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                    </select>
                    {clip.transition && <Slider label="Длительность" value={clip.transition.duration} min={0.1} max={3} step={0.05} def={0.6} unit=" с" onChange={v => commit('Длительность перехода', p => { const c = findClip(p, clip.id)!.clip as MediaClip; c.transition = { ...c.transition!, duration: v }; return [clip.id]; }, { coalesce: 'td:' + clip.id })} />}
                  </>
                ) : <div className="small-text muted">Это первый клип. Чтобы он плавно появился, включите «Появление» ниже.</div>}
              </div>
            )}
            <div className="insp-section">
              <h4>Размер в кадре</h4>
              <Segmented value={clip.fit} onChange={v => up({ fit: v }, v === 'fill' ? 'Заполнить кадр' : 'Вписать в кадр', '')}
                options={[{ value: 'fit', label: 'Вписать', tip: 'Видно весь кадр, по краям могут быть полосы' }, { value: 'fill', label: 'Заполнить', tip: 'Без полос, края обрежутся' }]} />
              <KeyBar clip={clip} up={up} />
              <Slider label="Масштаб" value={tr.scale} min={0.05} max={4} step={0.01} def={1} format={v => Math.round(v * 100) + '%'} onChange={v => up({ transform: { scale: v } }, 'Масштаб')} />
              <Slider label="По горизонтали" value={tr.x} min={-0.5} max={1.5} step={0.005} def={0.5} format={v => Math.round((v - 0.5) * 100) + '%'} onChange={v => up({ transform: { x: v } }, 'Положение')} hint="Можно просто перетащить картинку в окне просмотра" />
              <Slider label="По вертикали" value={tr.y} min={-0.5} max={1.5} step={0.005} def={0.5} format={v => Math.round((v - 0.5) * 100) + '%'} onChange={v => up({ transform: { y: v } }, 'Положение')} />
              <Slider label="Поворот" value={tr.rotation} min={-180} max={180} step={1} def={0} unit="°" onChange={v => up({ transform: { rotation: v } }, 'Поворот')} />
              <Slider label="Непрозрачность" value={tr.opacity} min={0} max={1} step={0.01} def={1} format={v => Math.round(v * 100) + '%'} onChange={v => up({ transform: { opacity: v } }, 'Прозрачность')} />
              <button className="btn small ghost" onClick={() => up({ keys: [], transform: trackKind === 'video' ? { x: 0.75, y: 0.27, scale: 0.4, rotation: 0, opacity: 1 } : defaultTransform() }, 'Положение сброшено', '')}><RotateCcw size={13} /> Сбросить положение</button>
            </div>
            <div className="insp-section">
              <h4>Появление и исчезновение</h4>
              <Slider label="Плавное появление" value={clip.fadeIn} min={0} max={3} step={0.05} def={0} unit=" с" onChange={v => up({ fadeIn: v }, 'Плавное появление')} />
              <Slider label="Плавное исчезновение" value={clip.fadeOut} min={0} max={3} step={0.05} def={0} unit=" с" onChange={v => up({ fadeOut: v }, 'Плавное исчезновение')} />
            </div>
            {m?.kind === 'video' && <ProcessSection clip={clip} />}
            <div className="insp-section" style={{ borderBottom: 0 }}>
              <div className="row wrap">
                {m?.kind === 'video' && <button className="btn small" onClick={() => A.freezeFrame(clip.id)}><Snowflake size={13} /> Стоп-кадр</button>}
                {m?.kind === 'video' && <button className="btn small" onClick={() => A.detectScenes(clip.id).catch(() => undefined)}><Scissors size={13} /> По сценам</button>}
                <button className="btn small danger" onClick={() => A.deleteClips([clip.id])}><Trash2 size={13} /> Удалить</button>
              </div>
            </div>
          </>
        )}
        {tab === 'color' && (
          <>
            <div className="insp-section">
              <h4>Готовые стили</h4>
              <div className="preset-grid">
                {Object.entries(COLOR_PRESETS).map(([id, pr]) => (
                  <button key={id} className={'preset' + (clip.color.preset === id ? ' on' : '')} onClick={() => up({ color: { preset: id as MediaClip['color']['preset'] } }, `Фильтр «${pr.label}»`, '')}>
                    <div className="p-img" style={{ backgroundImage: thumb ? `url("${mediaUrl(thumb)}")` : 'linear-gradient(135deg,#ff9a3d,#ff5c8a 40%,#7c5cff 70%,#2bd4c5)', filter: pr.css || undefined }} />
                    <span>{pr.label}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="insp-section">
              <h4>Тонкая настройка</h4>
              <Slider label="Яркость" value={clip.color.brightness} min={-0.5} max={0.5} step={0.01} def={0} format={v => (v > 0 ? '+' : '') + Math.round(v * 100)} onChange={v => up({ color: { brightness: v } }, 'Яркость')} />
              <Slider label="Контраст" value={clip.color.contrast} min={0.3} max={2} step={0.01} def={1} format={v => Math.round(v * 100) + '%'} onChange={v => up({ color: { contrast: v } }, 'Контраст')} />
              <Slider label="Насыщенность" value={clip.color.saturation} min={0} max={3} step={0.01} def={1} format={v => Math.round(v * 100) + '%'} onChange={v => up({ color: { saturation: v } }, 'Насыщенность')} hint="0% — чёрно-белое видео" />
              <Slider label="Гамма (средние тона)" value={clip.color.gamma} min={0.4} max={2.5} step={0.01} def={1} format={v => v.toFixed(2)} onChange={v => up({ color: { gamma: v } }, 'Гамма')} />
              <Slider label="Тепло / холод" value={clip.color.temperature} min={-1} max={1} step={0.01} def={0} format={v => (v > 0 ? 'теплее ' : v < 0 ? 'холоднее ' : '') + Math.abs(Math.round(v * 100))} onChange={v => up({ color: { temperature: v } }, 'Цветовая температура')} />
              <button className="btn small ghost" onClick={() => up({ color: defaultColor() }, 'Цвет сброшен', '')}><RotateCcw size={13} /> Сбросить цвет</button>
            </div>
            <div className="insp-section">
              <h4><FileImage size={14} /> LUT — готовый цветовой рецепт</h4>
              <div className="small-text muted">Файлы .cube продаются и раздаются бесплатно: «кино», «тёплый закат», «как на плёнке». Видно сразу в окне просмотра.</div>
              {clip.color.lut
                ? <div className="row"><span className="badge accent" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 170 }} data-tip={clip.color.lut}>{clip.color.lut.split(/[\\/]/).pop()}</span>
                  <button className="btn small ghost" onClick={() => up({ color: { lut: undefined } }, 'LUT убран', '')}>Убрать</button></div>
                : null}
              <button className="btn small" onClick={async () => { const f = await api.openLutDialog(); if (f) up({ color: { lut: f } }, 'LUT применён', ''); }}><FileImage size={13} /> {clip.color.lut ? 'Выбрать другой LUT' : 'Выбрать LUT-файл'}</button>
            </div>
          </>
        )}
        {tab === 'fx' && (
          <div className="insp-section">
            <Slider label="Размытие" value={clip.effects.blur} min={0} max={1} step={0.01} def={0} format={v => Math.round(v * 100) + '%'} onChange={v => up({ effects: { blur: v } }, 'Размытие')} />
            <Slider label="Резкость" value={clip.effects.sharpen} min={0} max={1} step={0.01} def={0} format={v => Math.round(v * 100) + '%'} onChange={v => up({ effects: { sharpen: v } }, 'Резкость')} hint="В окне просмотра не видна, появится в готовом видео" />
            <Slider label="Виньетка" value={clip.effects.vignette} min={0} max={1} step={0.01} def={0} format={v => Math.round(v * 100) + '%'} onChange={v => up({ effects: { vignette: v } }, 'Виньетка')} hint="Затемнение по краям" />
            <Slider label="Зерно плёнки" value={clip.effects.grain} min={0} max={1} step={0.01} def={0} format={v => Math.round(v * 100) + '%'} onChange={v => up({ effects: { grain: v } }, 'Зерно')} />
            <Switch label="Отразить по горизонтали" checked={clip.effects.flipH} onChange={v => up({ effects: { flipH: v } }, 'Отражение', '')} />
            <Switch label="Отразить по вертикали" checked={clip.effects.flipV} onChange={v => up({ effects: { flipV: v } }, 'Отражение', '')} />
            <button className="btn small ghost" onClick={() => up({ effects: defaultEffects() }, 'Эффекты сброшены', '')}><RotateCcw size={13} /> Сбросить эффекты</button>
            <KeySection clip={clip} up={up} />
          </div>
        )}
        {tab === 'motion' && <MotionTab clip={clip} up={up} />}
        {tab === 'audio' && (
          <div className="insp-section">
            <div className="card" style={{ gap: 8 }}>
              <div className="row"><Mic2 size={15} color="var(--accent)" /><b>Голос как в студии</b></div>
              <Switch label="Улучшить голос" hint="Убирает гул, делает речь разборчивее и ровнее по громкости" checked={!!clip.voice} onChange={v => up({ voice: v, denoise: v ? Math.max(clip.denoise || 0, 0.5) : clip.denoise }, v ? 'Голос как в студии' : 'Обработка голоса выключена', '')} />
              <Slider label="Убрать шум" value={clip.denoise || 0} min={0} max={1} step={0.05} def={0} format={v => (v ? Math.round(v * 100) + '%' : 'нет')} onChange={v => up({ denoise: v }, 'Шумоподавление')} hint="Шум улицы, гул компьютера, ветер" />
              {(clip.voice || (clip.denoise || 0) > 0) && (
                <div className="row wrap" style={{ gap: 6 }}>
                  <span className="small-text muted"><Headphones size={12} style={{ verticalAlign: -2 }} /> Послушать 8 секунд:</span>
                  <button className="btn small ghost" onClick={() => S.listenClip(clip.id, false)}>до</button>
                  <button className="btn small" onClick={() => S.listenClip(clip.id, true)}>после</button>
                </div>
              )}
            </div>
            <Slider label="Громкость" value={clip.volume} min={0} max={2} step={0.01} def={1} format={v => Math.round(v * 100) + '%'} onChange={v => up({ volume: v }, 'Громкость')} hint="Больше 100% — громче, чем в оригинале" />
            <Switch label="Без звука" checked={clip.muted} onChange={v => up({ muted: v }, v ? 'Звук выключен' : 'Звук включён', '')} />
            <Slider label="Плавное начало звука" value={clip.audioFadeIn} min={0} max={5} step={0.05} def={0} unit=" с" onChange={v => up({ audioFadeIn: v }, 'Плавное начало звука')} />
            <Slider label="Плавный конец звука" value={clip.audioFadeOut} min={0} max={5} step={0.05} def={0} unit=" с" onChange={v => up({ audioFadeOut: v }, 'Плавный конец звука')} />
            {trackKind === 'audio' && <Switch label="Приглушать, когда говорят" hint="Музыка становится тише, когда в основном видео звучит голос" checked={!!clip.duck} onChange={v => up({ duck: v }, v ? 'Музыка тише под голос' : 'Приглушение выключено', '')} />}
            {m?.kind === 'video' && m.hasAudio && <button className="btn small" onClick={() => A.detachAudio(clip.id)}><AudioLines size={13} /> Отделить звук на отдельную дорожку</button>}
            {trackKind === 'main' && m?.hasAudio && <button className="btn small" onClick={() => A.removeSilence({ clipId: clip.id })}><Scissors size={13} /> Убрать паузы в этом клипе</button>}
          </div>
        )}
      </div>
    </>
  );
}

function MotionTab({ clip, up }: { clip: MediaClip; up: (patch: A.MediaClipPatch, label: string, key?: string) => void }) {
  const t = clip.transform;
  const PRESETS: { label: string; start: Partial<MediaClip['transform']>; end: Partial<MediaClip['transform']> }[] = [
    { label: 'Приближение', start: { scale: t.scale }, end: { scale: t.scale * 1.2 } },
    { label: 'Отдаление', start: { scale: t.scale * 1.2 }, end: { scale: t.scale } },
    { label: 'Панорама влево', start: { scale: Math.max(1.15, t.scale), x: 0.56 }, end: { scale: Math.max(1.15, t.scale), x: 0.44 } },
    { label: 'Панорама вправо', start: { scale: Math.max(1.15, t.scale), x: 0.44 }, end: { scale: Math.max(1.15, t.scale), x: 0.56 } },
    { label: 'Вверх', start: { scale: Math.max(1.15, t.scale), y: 0.56 }, end: { scale: Math.max(1.15, t.scale), y: 0.44 } },
    { label: 'Поворот', start: { rotation: -3, scale: 1.1 }, end: { rotation: 3, scale: 1.1 } },
  ];
  return (
    <>
      <div className="insp-section">
        <div className="tip-card"><Move size={18} color="var(--accent)" style={{ flex: 'none' }} /><div>Клип плавно меняет размер и положение от начала к концу. Так «оживают» фотографии.</div></div>
        {!clip.keys?.length && <Switch label="Включить движение" checked={clip.animate} onChange={v => up({ animate: v }, v ? 'Движение включено' : 'Движение выключено', '')} />}
        <div className="row wrap" style={{ gap: 5 }}>
          {PRESETS.map(pr => (
            <button key={pr.label} className="chip" onClick={() => up({ keys: [], animate: true, transform: pr.start, transformEnd: { ...clip.transform, ...pr.start, ...pr.end } }, `Движение «${pr.label}»`, '')}>{pr.label}</button>
          ))}
        </div>
      </div>
      <KeysSection clip={clip} up={up} />
      {clip.animate && !clip.keys?.length && (
        <div className="insp-section">
          <h4>В конце клипа</h4>
          <Slider label="Масштаб" value={clip.transformEnd.scale} min={0.05} max={4} step={0.01} def={t.scale} format={v => Math.round(v * 100) + '%'} onChange={v => up({ transformEnd: { scale: v } }, 'Движение: масштаб')} />
          <Slider label="По горизонтали" value={clip.transformEnd.x} min={-0.5} max={1.5} step={0.005} def={t.x} format={v => Math.round((v - 0.5) * 100) + '%'} onChange={v => up({ transformEnd: { x: v } }, 'Движение: положение')} />
          <Slider label="По вертикали" value={clip.transformEnd.y} min={-0.5} max={1.5} step={0.005} def={t.y} format={v => Math.round((v - 0.5) * 100) + '%'} onChange={v => up({ transformEnd: { y: v } }, 'Движение: положение')} />
          <Slider label="Поворот" value={clip.transformEnd.rotation} min={-180} max={180} step={1} def={t.rotation} unit="°" onChange={v => up({ transformEnd: { rotation: v } }, 'Движение: поворот')} />
          <Slider label="Непрозрачность" value={clip.transformEnd.opacity} min={0} max={1} step={0.01} def={t.opacity} format={v => Math.round(v * 100) + '%'} onChange={v => up({ transformEnd: { opacity: v } }, 'Движение: прозрачность')} />
          <div className="small-text muted">Начало движения — это настройки на вкладке «Основное».</div>
        </div>
      )}
    </>
  );
}

type Up = (patch: A.MediaClipPatch, label: string, key?: string) => void;

// Ключевые кадры: ◆ ставит или убирает ключ под курсором, стрелки прыгают к соседним ключам
function KeyBar({ clip, up }: { clip: MediaClip; up: Up }) {
  const playhead = useStore(s => s.playhead);
  const local = playhead - clip.start;
  const inside = local >= -1e-3 && local <= clipDuration(clip) + 1e-3;
  const keys = clip.keys || [];
  const onKey = keys.find(k => Math.abs(k.t - local) < KEY_SNAP);
  const seek = (t: number) => set({ playhead: clip.start + t, playing: false });
  if (!keys.length) {
    return (
      <button className="btn small" disabled={!inside} style={{ alignSelf: 'flex-start' }}
        data-tip={inside ? 'Запомнить, как клип выглядит в этот момент. Потом передвиньте курсор и поменяйте размер или положение — клип плавно перейдёт от ключа к ключу' : 'Поставьте курсор таймлайна на этот клип'}
        onClick={() => up({ keys: setKeyAt(clip, local), animate: false }, 'Ключевой кадр', '')}>
        <Diamond size={13} /> Ключевые кадры
      </button>
    );
  }
  const prev = [...keys].reverse().find(k => k.t < local - KEY_SNAP / 2);
  const next = keys.find(k => k.t > local + KEY_SNAP / 2);
  return (
    <div className="keybar">
      <button className="icon-btn small" disabled={!prev} data-tip="К предыдущему ключу" onClick={() => prev && seek(prev.t)}><ChevronLeft size={15} /></button>
      <button className={'key-toggle' + (onKey ? ' on' : '')} disabled={!inside}
        data-tip={onKey ? 'Убрать этот ключ' : 'Поставить ключ здесь'}
        onClick={() => up({ keys: onKey ? removeKey(clip, onKey.t) : setKeyAt(clip, local), ...(onKey && keys.length === 1 ? { transform: transformAt(clip, local) } : {}) }, onKey ? 'Ключ убран' : 'Ключевой кадр', '')}>
        <Diamond size={14} fill={onKey ? 'currentColor' : 'none'} />
      </button>
      <button className="icon-btn small" disabled={!next} data-tip="К следующему ключу" onClick={() => next && seek(next.t)}><ChevronRight size={15} /></button>
      <span className="small-text muted" style={{ flex: 1 }}>{!inside ? 'Курсор не на клипе' : onKey ? 'Меняйте — правится этот ключ' : 'Измените — появится ключ'}</span>
      <button className="icon-btn small" data-tip="Убрать все ключи (клип останется как сейчас под курсором)" onClick={() => up({ keys: [], transform: transformAt(clip, Math.max(0, local)) }, 'Ключи убраны', '')}><Trash2 size={13} /></button>
    </div>
  );
}

function KeysSection({ clip, up }: { clip: MediaClip; up: Up }) {
  const keys = clip.keys || [];
  const fps = useStore(s => s.project?.fps || 30);
  const seek = (t: number) => set({ playhead: clip.start + t, playing: false });
  return (
    <div className="insp-section">
      <h4><Diamond size={14} /> Ключевые кадры</h4>
      {!keys.length && <div className="small-text muted">Как в больших редакторах: поставьте курсор в нужный момент, нажмите ◆ и меняйте размер, положение, поворот или прозрачность. Затем передвиньте курсор и поменяйте ещё раз — клип сам плавно пройдёт между этими точками. Можно двигать картинку прямо мышкой в окне просмотра.</div>}
      <KeyBar clip={clip} up={up} />
      {keys.length > 0 && (
        <div className="key-list">
          {clipKeys(clip).map((k, i, all) => (
            <div key={k.t} className="key-row">
              <button className="key-time" onClick={() => seek(k.t)} data-tip="Перейти к ключу"><Diamond size={11} fill="currentColor" /> {formatTime(k.t, fps, true)}</button>
              <span className="small-text muted">{Math.round(k.scale * 100)}%{k.rotation ? ` · ${Math.round(k.rotation)}°` : ''}{k.opacity < 1 ? ` · ${Math.round(k.opacity * 100)}% видно` : ''}</span>
              {i < all.length - 1 && (
                <button className="chip" data-tip="Как двигаться к следующему ключу: плавно разгоняясь и тормозя, или ровно с одной скоростью"
                  onClick={() => up({ keys: all.map(q => (q.t === k.t ? { ...q, ease: q.ease === 'linear' ? 'smooth' : 'linear' } : q)) }, 'Плавность движения', '')}>
                  {k.ease === 'linear' ? 'ровно' : 'плавно'}
                </button>
              )}
              <button className="icon-btn small" data-tip="Убрать ключ" onClick={() => up({ keys: removeKey(clip, k.t), ...(all.length === 1 ? { transform: { x: k.x, y: k.y, scale: k.scale, rotation: k.rotation, opacity: k.opacity } } : {}) }, 'Ключ убран', '')}><X size={13} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ProcessSection({ clip }: { clip: MediaClip }) {
  const tasks = useStore(s => s.tasks);
  const busy = tasks.some(t => t.label === 'Убираю тряску' || t.label === 'Переворачиваю видео');
  const done = clip.origin?.done || [];
  return (
    <div className="insp-section">
      <h4><Vibrate size={14} /> Обработка</h4>
      <div className="row wrap">
        <button className="btn small" disabled={busy} data-tip="Видео снимали с рук? Программа сгладит дрожание камеры. Занимает примерно столько же, сколько длится клип." onClick={() => S.processClip(clip.id, 'stabilize').catch(() => undefined)}><Vibrate size={13} /> {done.includes('stabilize') ? 'Сгладить ещё' : 'Убрать тряску'}</button>
        <button className="btn small" disabled={busy} data-tip="Клип проиграется с конца в начало, вместе со звуком" onClick={() => S.processClip(clip.id, 'reverse').catch(() => undefined)}><Rewind size={13} /> {done.includes('reverse') ? 'Снова вперёд' : 'Задом наперёд'}</button>
      </div>
      {clip.origin && (
        <div className="row wrap" style={{ gap: 6 }}>
          <span className="small-text muted">Сейчас: {done.length ? done.map(d => (d === 'stabilize' ? 'без тряски' : 'задом наперёд')).join(', ') : 'обработанная копия'}</span>
          <button className="btn small ghost" onClick={() => S.restoreOriginal(clip.id)}><Undo2 size={13} /> Вернуть оригинал</button>
        </div>
      )}
      {clip.path && (
        <div className="row wrap" style={{ gap: 6 }}>
          <span className="small-text" style={{ color: 'var(--good)' }}><ScanFace size={12} style={{ verticalAlign: -2 }} /> Камера следит за лицом</span>
          <button className="btn small ghost" onClick={() => S.clearPath(clip.id)}>Выключить</button>
        </div>
      )}
      <div className="small-text muted">Обработка делает копию файла в «Документы/Хлопушка/Обработка». Исходник не меняется.</div>
    </div>
  );
}

const KEY_COLORS = [{ c: '#00ff00', l: 'Зелёный' }, { c: '#00b140', l: 'Хромакей' }, { c: '#0047bb', l: 'Синий' }, { c: '#ffffff', l: 'Белый' }, { c: '#000000', l: 'Чёрный' }];

function KeySection({ clip, up }: { clip: MediaClip; up: (patch: A.MediaClipPatch, label: string, key?: string) => void }) {
  const k = clip.key;
  const set = (patch: Partial<NonNullable<MediaClip['key']>>, label: string, key?: string) => up({ key: { color: '#00ff00', similarity: 0.3, blend: 0.08, ...k, ...patch } }, label, key);
  return (
    <div className="card" style={{ gap: 8, marginTop: 6 }}>
      <div className="row"><Pipette size={15} color="var(--accent)" /><b>Убрать фон (хромакей)</b></div>
      <div className="small-text muted">Снимали на зелёном или синем фоне? Он станет прозрачным, а под ним будет видно то, что на дорожке ниже.</div>
      <Switch label="Включить" checked={!!k} onChange={v => (v ? set({}, 'Хромакей включён', '') : up({ key: undefined }, 'Хромакей выключен', ''))} />
      {k && <>
        <div className="row wrap" style={{ gap: 5 }}>
          {KEY_COLORS.map(x => <button key={x.c} data-tip={x.l} onClick={() => set({ color: x.c }, 'Цвет фона для хромакея', '')} style={{ width: 22, height: 22, borderRadius: 6, border: k.color === x.c ? '2px solid var(--accent)' : '1px solid var(--line-2)', background: x.c, cursor: 'pointer' }} />)}
        </div>
        <ColorInput label="Цвет фона" value={k.color} onChange={v => set({ color: v }, 'Цвет фона для хромакея', 'kc')} />
        <Slider label="Сила" value={k.similarity} min={0.02} max={0.6} step={0.01} def={0.3} format={v => Math.round(v * 100) + '%'} onChange={v => set({ similarity: v }, 'Хромакей: сила')} hint="Больше — убираются и похожие оттенки" />
        <Slider label="Мягкость края" value={k.blend} min={0} max={0.4} step={0.01} def={0.08} format={v => Math.round(v * 100) + '%'} onChange={v => set({ blend: v }, 'Хромакей: мягкость')} />
      </>}
    </div>
  );
}

// ── Текст ────────────────────────────────────────────
function TextInspector({ clip }: { clip: TextClip }) {
  const [tab, setTab] = useTab(['text', 'style', 'anim']);
  const [text, setText] = useState(clip.text);
  useEffect(() => setText(clip.text), [clip.text]);
  const st = clip.style;
  const up = (patch: A.TextClipPatch, label: string, key?: string) => A.updateTextClip(clip.id, patch, label, key === undefined ? {} : { coalesce: key });
  const s = (patch: Partial<TextClip['style']>, label: string, key?: string) => up({ style: patch }, label, key);
  return (
    <>
      <div className="clip-summary">
        <div className="thumb" style={{ background: 'color-mix(in srgb, var(--clip-text) 30%, var(--bg-2))' }}><Type size={18} color="var(--clip-text)" /></div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{clip.text.split('\n')[0] || 'Текст'}</div>
          <div className="small-text muted">{clip.subtitle ? 'субтитр' : 'текст'} · {formatTime(clip.duration, 30, true)}</div>
        </div>
      </div>
      <Tabs tabs={[{ id: 'text', label: 'Текст', icon: Type }, { id: 'style', label: 'Стиль', icon: Palette }, { id: 'anim', label: 'Анимация', icon: Sparkles }]} value={tab} onChange={setTab} />
      <div className="panel-body" style={{ padding: 0 }}>
        {tab === 'text' && (
          <div className="insp-section">
            <textarea className="input" rows={4} value={text} autoFocus={clip.text === 'Ваш текст'} onFocus={e => clip.text === 'Ваш текст' && e.target.select()}
              onChange={e => { setText(e.target.value); up({ text: e.target.value }, 'Текст изменён', 'text:' + clip.id); }} placeholder="Напишите текст. Enter — новая строка." />
            <div className="row">
              <div className="field grow"><label>Начало, с</label><input className="input" type="number" step={0.1} value={+clip.start.toFixed(2)} onChange={e => up({ start: Number(e.target.value) }, 'Время текста', 'ts:' + clip.id)} /></div>
              <div className="field grow"><label>Длится, с</label><input className="input" type="number" step={0.1} min={0.1} value={+clip.duration.toFixed(2)} onChange={e => up({ duration: Number(e.target.value) }, 'Длительность текста', 'td:' + clip.id)} /></div>
            </div>
            <div className="row">
              <button className="btn small" onClick={() => A.duplicateClips([clip.id])}>Дублировать</button>
              <button className="btn small danger" onClick={() => A.deleteClips([clip.id])}><Trash2 size={13} /> Удалить</button>
            </div>
          </div>
        )}
        {tab === 'style' && (
          <>
            <div className="insp-section">
              <div className="field">
                <label>Шрифт</label>
                <select className="input" value={st.font} onChange={e => s({ font: e.target.value }, 'Шрифт', '')} style={{ fontFamily: st.font }}>
                  {FONTS.map(f => <option key={f.family} value={f.family} style={{ fontFamily: f.family }}>{f.label} — {f.style}</option>)}
                </select>
              </div>
              <Slider label="Размер" value={st.size} min={10} max={300} step={1} def={70} onChange={v => s({ size: v }, 'Размер текста')} />
              <div className="row" style={{ gap: 4 }}>
                <button className={'icon-btn' + (st.bold ? ' active' : '')} onClick={() => s({ bold: !st.bold }, 'Жирный', '')} data-tip="Жирный"><Bold size={15} /></button>
                <button className={'icon-btn' + (st.italic ? ' active' : '')} onClick={() => s({ italic: !st.italic }, 'Курсив', '')} data-tip="Курсив"><Italic size={15} /></button>
                <button className={'icon-btn' + (st.uppercase ? ' active' : '')} onClick={() => s({ uppercase: !st.uppercase }, 'Заглавные буквы', '')} data-tip="ЗАГЛАВНЫЕ"><CaseUpper size={15} /></button>
                <div className="spacer" />
                <Segmented value={st.align} onChange={v => s({ align: v }, 'Выравнивание', '')} options={[
                  { value: 'left', label: <AlignLeft size={14} /> }, { value: 'center', label: <AlignCenter size={14} /> }, { value: 'right', label: <AlignRight size={14} /> }]} />
              </div>
              <ColorInput label="Цвет" value={st.color} onChange={v => s({ color: v }, 'Цвет текста', 'tc')} />
              <div className="row wrap" style={{ gap: 5 }}>
                {['#ffffff', '#000000', '#ffe14d', '#ff5c8a', '#7c5cff', '#2bd4c5', '#3ddc97', '#ff7a3d'].map(c => (
                  <button key={c} onClick={() => s({ color: c }, 'Цвет текста', '')} style={{ width: 22, height: 22, borderRadius: 6, border: st.color === c ? '2px solid var(--accent)' : '1px solid var(--line-2)', background: c, cursor: 'pointer' }} />
                ))}
              </div>
            </div>
            {clip.words?.length ? (
              <div className="insp-section">
                <h4><Highlighter size={14} /> Подсветка слова</h4>
                <div className="small-text muted">Слово, которое сейчас звучит, выделяется цветом.</div>
                <div className="row wrap" style={{ gap: 5 }}>
                  {S.HIGHLIGHTS.map(c => <button key={c} onClick={() => up({ highlight: c }, 'Цвет подсветки', '')} style={{ width: 22, height: 22, borderRadius: 6, border: clip.highlight === c ? '2px solid var(--accent)' : '1px solid var(--line-2)', background: c, cursor: 'pointer' }} />)}
                  <button className="btn small ghost" onClick={() => up({ highlight: undefined }, 'Подсветка выключена', '')}>Без подсветки</button>
                </div>
              </div>
            ) : null}
            <div className="insp-section">
              <h4>Место в кадре</h4>
              <div className="row" style={{ gap: 5 }}>
                <button className="btn small" onClick={() => s({ y: 0.15 }, 'Текст наверху', '')}>Сверху</button>
                <button className="btn small" onClick={() => s({ x: 0.5, y: 0.5 }, 'Текст по центру', '')}>По центру</button>
                <button className="btn small" onClick={() => s({ y: 0.85 }, 'Текст внизу', '')}>Снизу</button>
              </div>
              <Slider label="По горизонтали" value={st.x} min={0} max={1} step={0.005} def={0.5} format={v => Math.round(v * 100) + '%'} onChange={v => s({ x: v }, 'Положение текста')} hint="Текст можно перетащить мышью прямо в окне просмотра" />
              <Slider label="По вертикали" value={st.y} min={0} max={1} step={0.005} def={0.5} format={v => Math.round(v * 100) + '%'} onChange={v => s({ y: v }, 'Положение текста')} />
              <Slider label="Ширина строки" value={st.maxWidth} min={0.1} max={1} step={0.01} def={0.9} format={v => Math.round(v * 100) + '%'} onChange={v => s({ maxWidth: v }, 'Ширина текста')} />
              <Slider label="Между строками" value={st.lineHeight} min={0.8} max={2.5} step={0.05} def={1.2} format={v => v.toFixed(2)} onChange={v => s({ lineHeight: v }, 'Межстрочный интервал')} />
            </div>
            <div className="insp-section">
              <h4>Оформление</h4>
              <Slider label="Обводка" value={st.strokeWidth} min={0} max={20} step={0.5} def={0} unit=" px" onChange={v => s({ strokeWidth: v }, 'Обводка')} />
              {st.strokeWidth > 0 && <ColorInput label="Цвет обводки" value={st.strokeColor} onChange={v => s({ strokeColor: v }, 'Цвет обводки', 'sc')} />}
              <Switch label="Тень" checked={st.shadow} onChange={v => s({ shadow: v }, 'Тень', '')} />
              <Switch label="Плашка под текстом" checked={st.background} onChange={v => s({ background: v }, 'Плашка', '')} />
              {st.background && <>
                <ColorInput label="Цвет плашки" value={st.backgroundColor} onChange={v => s({ backgroundColor: v }, 'Цвет плашки', 'bc')} />
                <Slider label="Плотность плашки" value={st.backgroundOpacity} min={0} max={1} step={0.01} def={0.6} format={v => Math.round(v * 100) + '%'} onChange={v => s({ backgroundOpacity: v }, 'Плотность плашки')} />
              </>}
            </div>
          </>
        )}
        {tab === 'anim' && (
          <div className="insp-section">
            <div className="field"><label>Появление</label>
              <div className="row wrap" style={{ gap: 5 }}>{TEXT_ANIMS.map(a => <AnimChip key={a.id} on={clip.animIn === a.id} label={a.label} onClick={() => { up({ animIn: a.id as TextAnim }, 'Анимация появления', ''); set({ playhead: clip.start, playing: true }); }} />)}</div>
            </div>
            <div className="field"><label>Исчезновение</label>
              <div className="row wrap" style={{ gap: 5 }}>{TEXT_ANIMS.map(a => <AnimChip key={a.id} on={clip.animOut === a.id} label={a.label} onClick={() => { up({ animOut: a.id as TextAnim }, 'Анимация исчезновения', ''); set({ playhead: Math.max(clip.start, clip.start + clip.duration - clip.animDuration - 0.4), playing: true }); }} />)}</div>
            </div>
            <Slider label="Скорость анимации" value={clip.animDuration} min={0.1} max={2} step={0.05} def={0.4} unit=" с" onChange={v => up({ animDuration: v }, 'Длительность анимации')} />
            <div className="small-text muted">При выборе анимации ролик сразу проигрывается с этого места — чтобы вы увидели результат.</div>
          </div>
        )}
      </div>
    </>
  );
}

function AnimChip({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return <button className="chip" onClick={onClick} style={on ? { borderColor: 'var(--accent)', color: 'var(--text)', background: 'var(--accent-soft)' } : undefined}>{on ? '✓ ' : ''}{label}</button>;
}
