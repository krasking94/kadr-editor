// Разделы настроек клипа, появившиеся в 0.9: скорость по кривой, слежение за объектом,
// мультикамера и вложенные клипы.
import { useEffect, useRef, useState } from 'react';
import { Activity, Crosshair, Group, Ungroup, Video, Type, EyeOff, X, Link2, Volume2, Layers } from 'lucide-react';
import type { MediaClip, RampPoint, TextClip } from '../../shared/types';
import { formatTime } from '../../shared/timeline';
import { normRamp, rampCurve, RAMP_MAX, RAMP_MIN, RAMP_PRESETS } from '../../shared/ramp';
import { groupOf } from '../../shared/multicam';
import { useStore } from '../state/store';
import { mediaUrl } from '../api';
import { applyRamp, clearRamp, rampPreviewLength, rampSource } from '../state/ramp';
import { addTextOnObject, attachToObject, blurObject, clearTrack, startPick } from '../state/track';
import { flattenMulticam, setCamAudio, setCamOffset, switchCamera } from '../state/multicam';
import { canGroup, groupClips, ungroupClip } from '../state/group';
import { Slider } from './ui';

// ── Скорость по кривой ──────────────────────────────
const LOG_MIN = Math.log(RAMP_MIN), LOG_MAX = Math.log(RAMP_MAX);
const sy = (s: number) => 1 - (Math.log(s) - LOG_MIN) / (LOG_MAX - LOG_MIN); // 0 сверху (быстро), 1 снизу (медленно)
const ys = (y: number) => Math.exp(LOG_MIN + (1 - Math.max(0, Math.min(1, y))) * (LOG_MAX - LOG_MIN));

function RampEditor({ points, onChange }: { points: RampPoint[]; onChange: (p: RampPoint[]) => void }) {
  const ref = useRef<SVGSVGElement>(null);
  const W = 260, H = 110;
  const pts = normRamp(points);
  const curve = rampCurve(pts, 64);
  const path = curve.map((c, i) => `${i ? 'L' : 'M'}${(c.u * W).toFixed(1)},${(sy(c.s) * H).toFixed(1)}`).join(' ');
  const at = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    return { u: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
  };
  const drag = (i: number) => (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    if (e.button === 2) {
      // правая кнопка — убрать точку (крайние не убираются)
      if (i > 0 && i < pts.length - 1) onChange(pts.filter((_, k) => k !== i));
      return;
    }
    const move = (ev: PointerEvent) => {
      const a = at(ev);
      const next = pts.map(p => ({ ...p }));
      const lo = i === 0 ? 0 : next[i - 1].u + 0.02, hi = i === next.length - 1 ? 1 : next[i + 1].u - 0.02;
      next[i] = { u: i === 0 ? 0 : i === next.length - 1 ? 1 : Math.max(lo, Math.min(hi, a.u)), s: Math.round(ys(a.y) * 100) / 100 };
      onChange(next);
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const add = (e: React.MouseEvent) => {
    const a = at(e);
    onChange(normRamp([...pts, { u: a.u, s: Math.round(ys(a.y) * 100) / 100 }]));
  };
  const lines = [0.25, 0.5, 1, 2, 4];
  return (
    <div className="ramp-box">
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="ramp-svg" onDoubleClick={add} onContextMenu={e => e.preventDefault()}>
        {lines.map(s => (
          <g key={s}>
            <line x1={0} x2={W} y1={sy(s) * H} y2={sy(s) * H} className={s === 1 ? 'ramp-one' : 'ramp-grid'} />
            <text x={3} y={sy(s) * H - 2} className="ramp-label">×{s}</text>
          </g>
        ))}
        <path d={`${path} L${W},${H} L0,${H} Z`} className="ramp-fill" />
        <path d={path} className="ramp-line" />
        {pts.map((p, i) => <circle key={i} cx={p.u * W} cy={sy(p.s) * H} r={5} className="ramp-dot" onPointerDown={drag(i)} />)}
      </svg>
      <div className="small-text muted">Выше — быстрее, ниже — медленнее. Двойной щелчок добавляет точку, правый щелчок по точке убирает её.</div>
    </div>
  );
}

export function RampSection({ clip }: { clip: MediaClip }) {
  const busy = useStore(s => s.tasks.some(t => t.label === 'Меняю скорость по кривой'));
  const saved = clip.origin?.ramp?.points;
  const [pts, setPts] = useState<RampPoint[]>(saved || RAMP_PRESETS[0].points);
  const [open, setOpen] = useState(!!saved);
  useEffect(() => { if (saved) setPts(saved); }, [clip.id]);
  const src = rampSource(clip);
  const len = rampPreviewLength(clip, pts);
  const preset = RAMP_PRESETS.find(r => JSON.stringify(r.points) === JSON.stringify(pts));
  return (
    <div className="insp-section">
      <h4><Activity size={14} /> Скорость по кривой</h4>
      {!open ? (
        <>
          <div className="small-text muted">Клип плавно разгоняется и замедляется — как в спортивных роликах и клипах. Выберите готовый вариант или нарисуйте свой.</div>
          <div className="row wrap" style={{ gap: 5 }}>
            {RAMP_PRESETS.map(r => <button key={r.id} className="chip" data-tip={r.tip} onClick={() => { setPts(r.points); setOpen(true); }}>{r.label}</button>)}
          </div>
        </>
      ) : (
        <>
          <div className="row wrap" style={{ gap: 5 }}>
            {RAMP_PRESETS.map(r => <button key={r.id} className={'chip' + (preset?.id === r.id ? ' on' : '')} data-tip={r.tip} onClick={() => setPts(r.points)}>{r.label}</button>)}
          </div>
          <RampEditor points={pts} onChange={setPts} />
          <div className="small-text">Было {formatTime(src.out - src.in)} → станет <b>{formatTime(len)}</b></div>
          <div className="row wrap">
            <button className="btn small primary" disabled={busy} onClick={() => applyRamp(clip.id, pts).catch(() => undefined)}><Activity size={13} /> {saved ? 'Применить заново' : 'Применить'}</button>
            {saved ? <button className="btn small ghost" onClick={() => clearRamp(clip.id)}><X size={13} /> Обычная скорость</button>
              : <button className="btn small ghost" onClick={() => setOpen(false)}>Свернуть</button>}
          </div>
          <div className="small-text muted">Программа сделает копию клипа с новой скоростью (вместе со звуком). Исходник не меняется.</div>
        </>
      )}
    </div>
  );
}

// ── Слежение за объектом ────────────────────────────
export function TrackSection({ clip }: { clip: MediaClip }) {
  const project = useStore(s => s.project)!;
  const busy = useStore(s => s.tasks.some(t => t.label === 'Слежу за объектом'));
  const picking = useStore(s => s.trackPick === clip.id);
  const tr = clip.track;
  const fol = project.tracks.flatMap(t => t.clips).filter(c => c.follow?.clipId === clip.id);
  return (
    <div className="insp-section">
      <h4><Crosshair size={14} /> Слежение за объектом</h4>
      {!tr ? (
        <>
          <div className="small-text muted">Обведите в кадре человека, машину или предмет — программа проследит за ним по всему клипу. Потом к нему можно прикрепить надпись, стрелку или размыть его (номер, логотип, экран).</div>
          <button className="btn small primary" disabled={busy || picking} onClick={() => startPick(clip.id)}><Crosshair size={13} /> {picking ? 'Обведите объект в кадре…' : 'Выбрать объект'}</button>
        </>
      ) : (
        <>
          <span className="small-text" style={{ color: 'var(--good)' }}>Объект найден · {tr.samples.length} точек</span>
          <div className="row wrap">
            <button className="btn small" onClick={() => addTextOnObject(clip.id)}><Type size={13} /> Надпись на объект</button>
            <button className="btn small" onClick={() => blurObject(clip.id)}><EyeOff size={13} /> Размыть объект</button>
          </div>
          {fol.length > 0 && <div className="small-text muted">За объектом едут: {fol.length} {fol.length === 1 ? 'слой' : 'слоя'}</div>}
          <div className="row wrap">
            <button className="btn small ghost" disabled={busy || picking} onClick={() => startPick(clip.id)}>Выбрать заново</button>
            <button className="btn small ghost" onClick={() => clearTrack(clip.id)}><X size={13} /> Убрать</button>
          </div>
        </>
      )}
    </div>
  );
}

/** Для надписи, стикера или наложения: «ехать за объектом» */
export function FollowSection({ clip }: { clip: TextClip | MediaClip }) {
  const project = useStore(s => s.project)!;
  const sources = project.tracks.flatMap(t => t.clips).filter((c): c is MediaClip => c.type === 'media' && !!c.track && c.id !== clip.id);
  if (!sources.length && !clip.follow) return null;
  const name = (c: MediaClip) => {
    const m = project.media.find(x => x.id === c.mediaId);
    return `${c.track?.label || m?.name || 'Клип'} (${formatTime(c.start)})`;
  };
  return (
    <div className="insp-section">
      <h4><Link2 size={14} /> Ехать за объектом</h4>
      <select className="input" value={clip.follow?.clipId || ''} onChange={e => attachToObject(clip.id, e.target.value || null)}>
        <option value="">Стоит на месте</option>
        {sources.map(c => <option key={c.id} value={c.id}>{name(c)}</option>)}
      </select>
      <div className="small-text muted">Слой повторяет движение объекта, за которым следит программа. Положение слоя задаёт, где он относительно объекта.</div>
    </div>
  );
}

// ── Мультикамера ────────────────────────────────────
export function MulticamSection({ clip }: { clip: MediaClip }) {
  const project = useStore(s => s.project)!;
  const cache = useStore(s => s.mediaCache);
  const g = groupOf(project, clip);
  if (!g || !clip.cam) return null;
  return (
    <div className="insp-section">
      <h4><Video size={14} /> Мультикамера · {g.name}</h4>
      <div className="cam-grid">
        {g.angles.map((a, i) => {
          const m = project.media.find(x => x.id === a.mediaId);
          const th = m ? cache[m.id]?.thumb : undefined;
          return (
            <button key={i} className={'cam-tile' + (clip.cam!.angle === i ? ' on' : '')} data-tip={`Весь этот кусок — с камеры ${i + 1}. Во время просмотра жмите ${i + 1}, чтобы переключать по ходу`}
              onClick={() => switchCamera(i, { clipId: clip.id, whole: true })}
              style={{ backgroundImage: th ? `url("${mediaUrl(th)}")` : undefined }}>
              <span>{i + 1}</span>
            </button>
          );
        })}
      </div>
      <div className="small-text muted">Нажмите пробел и переключайте камеры клавишами 1–{Math.min(9, g.angles.length)} прямо во время просмотра.</div>
      <label className="small-text muted"><Volume2 size={12} style={{ verticalAlign: -2 }} /> Звук</label>
      <select className="input" value={g.audio} onChange={e => setCamAudio(g.id, Number(e.target.value))}>
        <option value={-1}>С той камеры, что в кадре</option>
        {g.angles.map((a, i) => <option key={i} value={i}>С камеры {i + 1}{i === 0 ? ' (обычно лучший микрофон)' : ''}</option>)}
      </select>
      {g.angles.length > 1 && clip.cam.angle > 0 && (
        <Slider label={`Сдвиг камеры ${clip.cam.angle + 1}`} value={g.angles[clip.cam.angle].offset} min={g.angles[clip.cam.angle].offset - 2} max={g.angles[clip.cam.angle].offset + 2} step={1 / 100}
          format={v => (v >= 0 ? '+' : '') + v.toFixed(2) + ' с'} onChange={v => setCamOffset(g.id, clip.cam!.angle, v)}
          hint="Если губы не попадают в звук — подвиньте. Программа выравнивает по звуку сама, это для тонкой подстройки" />
      )}
      <button className="btn small ghost" data-tip="Клипы станут обычными, переключать камеры будет нельзя" onClick={() => flattenMulticam(g.id)}>Сделать обычными клипами</button>
    </div>
  );
}

// ── Вложенные клипы ─────────────────────────────────
export function GroupButton({ ids }: { ids: string[] }) {
  const busy = useStore(s => s.tasks.some(t => t.label === 'Собираю клипы в один'));
  useStore(s => s.project);
  const why = canGroup(ids);
  return (
    <button className="btn small" disabled={busy || !!why} data-tip={why || 'Выбранные клипы (и всё, что лежит над ними) станут одним клипом. Его можно двигать, красить и ускорять целиком. Ctrl+G'}
      onClick={() => groupClips(ids).catch(() => undefined)}><Group size={13} /> Объединить в один клип</button>
  );
}

export function GroupSection({ clip }: { clip: MediaClip }) {
  if (!clip.group) return null;
  const n = clip.group.main.length + clip.group.layers.reduce((s, l) => s + l.clips.length, 0);
  return (
    <div className="insp-section">
      <h4><Layers size={14} /> Вложенный клип</h4>
      <div className="small-text muted">Внутри {n} {n < 5 ? 'клипа' : 'клипов'}. Если нужно что-то поменять внутри — разберите его обратно.</div>
      <button className="btn small" onClick={() => ungroupClip(clip.id)}><Ungroup size={13} /> Разобрать (Ctrl+Shift+G)</button>
    </div>
  );
}

