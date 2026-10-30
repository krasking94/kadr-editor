// Окно «Сохранить видео»: формат, качество, размер, место. Во время сохранения — прогресс и время.
import { useEffect, useMemo, useState } from 'react';
import { CircleCheck, Download, ListPlus, Volume2, Film, FolderOpen, Gauge, Image as ImageIcon, Music, Play, Smartphone, TriangleAlert, Tv } from 'lucide-react';
import { api } from '../api';
import type { ExportOptions } from '../../shared/types';
import { clipEnd, findClip, formatTime, projectDuration } from '../../shared/timeline';
import { get, set, useStore } from '../state/store';
import { exportVideo, queueExport } from '../state/actions';
import { EXTRA_FORMATS, queueFormats } from '../state/script';
import { Modal, Segmented } from './ui';

type Format = ExportOptions['format'];
const FORMATS: { id: Format; label: string; hint: string; icon: typeof Film }[] = [
  { id: 'mp4', label: 'MP4', hint: 'Подходит везде. Рекомендуем', icon: Film },
  { id: 'mov', label: 'MOV', hint: 'Для Apple и монтажа', icon: Film },
  { id: 'webm', label: 'WebM', hint: 'Для сайтов, меньше размер', icon: Film },
  { id: 'gif', label: 'GIF', hint: 'Анимация для чатов, без звука', icon: ImageIcon },
  { id: 'mp3', label: 'MP3', hint: 'Только звук', icon: Music },
  { id: 'wav', label: 'WAV', hint: 'Звук без сжатия', icon: Music },
];

const PRESETS: { label: string; icon: typeof Film; apply: { format: Format; height?: number; quality: ExportOptions['quality'] } }[] = [
  { label: 'YouTube', icon: Tv, apply: { format: 'mp4', quality: 'best' } },
  { label: 'Telegram, ВК', icon: Smartphone, apply: { format: 'mp4', height: 1080, quality: 'good' } },
  { label: 'Быстро проверить', icon: Gauge, apply: { format: 'mp4', height: 480, quality: 'draft' } },
  { label: 'GIF для чата', icon: ImageIcon, apply: { format: 'gif', height: 360, quality: 'good' } },
];

const ENCODER_LABEL: Record<string, string> = { auto: 'Автоматически', cpu: 'Процессор', nvenc: 'Видеокарта NVIDIA', qsv: 'Графика Intel', amf: 'Видеокарта AMD' };

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export function ExportDialog() {
  const project = useStore(s => s.project)!;
  const info = useStore(s => s.info);
  const settings = useStore(s => s.settings);
  const tasks = useStore(s => s.tasks);
  const selection = useStore(s => s.selection);
  const [format, setFormat] = useState<Format>('mp4');
  const [fps, setFps] = useState(project.fps);
  const [quality, setQuality] = useState<ExportOptions['quality']>('good');
  const [encoder, setEncoder] = useState<ExportOptions['encoder']>(settings.encoder || 'auto');
  const [range, setRange] = useState<'all' | 'selection' | 'markers'>('all');
  const [path, setPath] = useState('');
  const [state, setState] = useState<'setup' | 'running' | 'done' | 'error'>('setup');
  const [progress, setProgress] = useState(0);
  const [speed, setSpeed] = useState('');
  const [result, setResult] = useState<{ outPath?: string; error?: string; seconds?: number }>({});
  const [startedAt, setStartedAt] = useState(0);
  const [loudness, setLoudness] = useState(settings.loudness ?? -14);
  const [extra, setExtra] = useState<string[]>([]);
  const queue = useStore(s => s.exportQueue);
  const busyQueue = queue.filter(q => q.state === 'wait' || q.state === 'run').length;
  const duration = projectDuration(project);

  const aspect = project.width / project.height;
  const portrait = project.height > project.width;
  // варианты размера по меньшей стороне кадра
  const sizes = useMemo(() => {
    const base = Math.min(project.width, project.height);
    const list = [2160, 1440, 1080, 720, 480, 360].filter(s => s <= Math.max(base, 2160));
    if (!list.includes(base)) list.unshift(base);
    return [...new Set(list)].sort((a, b) => b - a);
  }, [project.width, project.height]);
  const [shortSide, setShortSide] = useState(Math.min(project.width, project.height));
  const W = portrait ? even(shortSide) : even(shortSide * aspect);
  const H = portrait ? even(shortSide / aspect) : even(shortSide);

  const sel = selection.map(id => findClip(project, id)?.clip).filter(Boolean);
  const selRange = sel.length ? { start: Math.min(...sel.map(c => c!.start)), end: Math.max(...sel.map(c => clipEnd(c!))) } : null;
  const mk = project.markers;
  const mkRange = mk.length >= 2 ? { start: mk[0].time, end: mk[mk.length - 1].time } : null;
  const r = range === 'selection' && selRange ? selRange : range === 'markers' && mkRange ? mkRange : { start: 0, end: duration };
  const len = Math.max(0, r.end - r.start);

  const ext = format;
  useEffect(() => {
    const sep = (info?.videosDir || '').includes('\\') ? '\\' : '/';
    const dir = settings.exportDir || info?.videosDir || '';
    setPath(p => {
      const base = p ? p.replace(/\.[a-z0-9]+$/i, '') : `${dir}${sep}${project.name.replace(/[\\/:*?"<>|]+/g, '_')}`;
      return `${base}.${ext}`;
    });
  }, [ext]);

  useEffect(() => api.onExportProgress((ev: { progress: number; speed: string }) => { setProgress(ev.progress); setSpeed(ev.speed); }), []);

  const audioOnly = format === 'mp3' || format === 'wav';
  // примерный размер файла
  const mbps = format === 'gif' ? 6 : audioOnly ? (format === 'wav' ? 1.5 : 0.19) : (W * H) / (1920 * 1080) * (fps / 30) * { draft: 3, good: 8, best: 16 }[quality] * (format === 'webm' ? 0.7 : 1);
  const sizeMb = (mbps * len) / 8;

  const pick = async () => {
    const p = await api.exportPathDialog(project.name, ext);
    if (p) setPath(p);
  };

  const options = (): ExportOptions => ({
    outPath: path, format, width: W, height: H, fps, quality, encoder,
    rangeStart: r.start > 0 ? r.start : undefined, rangeEnd: r.end < duration ? r.end : undefined,
    loudness: format === 'gif' || !loudness ? undefined : loudness,
  });
  // «Несколько форматов за раз»: копии в другом формате (вертикаль, квадрат) ставятся в очередь
  const extraOk = format === 'mp4' || format === 'mov' || format === 'webm';
  const otherFormats = EXTRA_FORMATS.filter(f => Math.abs(f.width / f.height - project.width / project.height) > 0.01);
  const queueExtra = async () => {
    const ids = extraOk ? extra.filter(id => otherFormats.some(f => f.id === id)) : [];
    if (ids.length) await queueFormats(ids, options());
  };
  const toQueue = async () => {
    await queueExport(options());
    await queueExtra();
    // следующий файл в очереди получит другое имя, чтобы не перезаписать этот
    setPath(p => p.replace(/(?: \((\d+)\))?(\.[a-z0-9]+)$/i, (_m, n, e) => ` (${(Number(n) || 1) + 1})${e}`));
  };
  const start = async () => {
    setState('running');
    setProgress(0);
    setStartedAt(Date.now());
    await queueExtra();
    const res = await exportVideo(options());
    setResult(res);
    setState(res.ok ? 'done' : res.canceled ? 'setup' : 'error');
  };
  const cancel = () => tasks.find(t => t.label.startsWith('Сохраняю видео'))?.cancel?.();
  const close = () => { if (state === 'running') return; set({ dialog: null }); };
  const elapsed = startedAt ? (Date.now() - startedAt) / 1000 : 0;
  const eta = progress > 0.02 ? elapsed / progress - elapsed : 0;

  if (state === 'running' || state === 'done' || state === 'error') {
    return (
      <Modal title={state === 'running' ? 'Сохраняю видео…' : state === 'done' ? 'Готово!' : 'Не получилось'} icon={state === 'done' ? <CircleCheck size={20} color="var(--good)" /> : state === 'error' ? <TriangleAlert size={20} color="var(--bad)" /> : <span className="spinner" />}
        onClose={close} width={520}
        footer={state === 'running'
          ? <><span className="muted small-text" style={{ marginRight: 'auto' }}>Можно работать дальше, видео сохраняется в фоне</span><button className="btn" onClick={() => set({ dialog: null })}>Свернуть</button><button className="btn danger" onClick={cancel}>Отменить</button></>
          : state === 'done'
            ? <><button className="btn" onClick={() => api.showItem(result.outPath!)}><FolderOpen size={15} /> Показать в папке</button><button className="btn primary" onClick={() => api.openPath(result.outPath!)}><Play size={15} /> Открыть видео</button></>
            : <><button className="btn" onClick={() => set({ dialog: null })}>Закрыть</button><button className="btn primary" onClick={() => setState('setup')}>Попробовать снова</button></>}>
        {state === 'running' && (
          <>
            <div className="progress" style={{ width: '100%', height: 10 }}><div style={{ width: `${progress * 100}%` }} /></div>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <b style={{ fontSize: 22, fontFamily: 'var(--mono)' }}>{Math.round(progress * 100)}%</b>
              <span className="muted">{speed && `скорость ${speed} · `}{eta > 0 ? `осталось ≈ ${formatTime(eta)}` : 'считаю время…'}</span>
            </div>
            <div className="small-text muted">{W}×{H}, {fps} кадр/с, {format.toUpperCase()} → {path}</div>
          </>
        )}
        {state === 'done' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div>Видео сохранено за {formatTime(result.seconds || 0)}.</div>
            <div className="code-box">{result.outPath}</div>
          </div>
        )}
        {state === 'error' && <div className="code-box" style={{ whiteSpace: 'pre-wrap' }}>{result.error}</div>}
      </Modal>
    );
  }

  return (
    <Modal title="Сохранить видео" icon={<Download size={18} />} onClose={close} width={760}
      footer={<>
        <span className="muted small-text" style={{ marginRight: 'auto' }}>
          {formatTime(len)} · примерно {sizeMb < 1 ? '< 1' : Math.round(sizeMb)} МБ
        </span>
        <button className="btn" onClick={close}>Отмена</button>
        <button className="btn" disabled={!path || len <= 0} onClick={toQueue} data-tip={'Запомнить ролик таким, какой он сейчас, и сохранить, когда закончатся остальные.\nМожно поставить несколько вариантов подряд: для YouTube, Reels и Telegram.'} data-tip-pos="top">
          <ListPlus size={15} /> В очередь{busyQueue ? ` (${busyQueue})` : ''}
        </button>
        <button className="btn primary" disabled={!path || len <= 0} onClick={start}><Download size={15} /> Сохранить</button>
      </>}>
      <div>
        <div className="section-title" style={{ marginTop: 0 }}>Быстрый выбор</div>
        <div className="row wrap">
          {PRESETS.map(p => (
            <button key={p.label} className="chip" onClick={() => { setFormat(p.apply.format); setQuality(p.apply.quality); setShortSide(p.apply.height ? Math.min(p.apply.height, sizes[0]) : sizes[0]); }}>
              <p.icon size={13} style={{ verticalAlign: -2, marginRight: 4 }} />{p.label}
            </button>
          ))}
        </div>
      </div>
      <div>
        <div className="section-title">Формат</div>
        <div className="choice-grid">
          {FORMATS.map(f => (
            <button key={f.id} className={'choice' + (format === f.id ? ' on' : '')} onClick={() => setFormat(f.id)}>
              <b><f.icon size={14} style={{ verticalAlign: -2, marginRight: 5 }} />{f.label}</b><small>{f.hint}</small>
            </button>
          ))}
        </div>
      </div>
      {!audioOnly && (
        <div className="row wrap" style={{ gap: 18, alignItems: 'flex-start' }}>
          <div className="field" style={{ minWidth: 220 }}>
            <label>Размер</label>
            <select className="input" value={shortSide} onChange={e => setShortSide(Number(e.target.value))}>
              {sizes.map(s => {
                const w = portrait ? even(s) : even(s * aspect), h = portrait ? even(s / aspect) : even(s);
                const name = s >= 2160 ? '4K' : s >= 1440 ? '2K' : s >= 1080 ? 'Full HD' : s >= 720 ? 'HD' : 'маленький';
                return <option key={s} value={s}>{w}×{h} · {name}</option>;
              })}
            </select>
          </div>
          <div className="field">
            <label>Кадров в секунду</label>
            <Segmented value={String(fps)} onChange={v => setFps(Number(v))} options={[...new Set([project.fps, 24, 30, 60])].sort((a, b) => a - b).map(v => ({ value: String(v), label: String(v) }))} />
          </div>
          <div className="field">
            <label>Качество</label>
            <Segmented value={quality} onChange={setQuality} options={[{ value: 'draft', label: 'Черновик', tip: 'Быстро, файл меньше' }, { value: 'good', label: 'Хорошее' }, { value: 'best', label: 'Лучшее', tip: 'Дольше, файл больше' }]} />
          </div>
        </div>
      )}
      <div className="row wrap" style={{ gap: 18, alignItems: 'flex-start' }}>
        <div className="field">
          <label>Что сохранить</label>
          <Segmented value={range} onChange={setRange} options={[
            { value: 'all', label: 'Весь ролик' },
            ...(selRange ? [{ value: 'selection' as const, label: 'Выбранные клипы', tip: `${formatTime(selRange.start)}–${formatTime(selRange.end)}` }] : []),
            ...(mkRange ? [{ value: 'markers' as const, label: 'Между метками', tip: `${formatTime(mkRange.start)}–${formatTime(mkRange.end)}` }] : []),
          ]} />
        </div>
        {format !== 'gif' && (
          <div className="field" style={{ minWidth: 220 }}>
            <label><Volume2 size={12} style={{ verticalAlign: -1 }} /> Громкость</label>
            <select className="input" value={loudness} onChange={e => setLoudness(Number(e.target.value))}>
              <option value={-14}>Для YouTube, ВК, Telegram (−14 LUFS)</option>
              <option value={-16}>Для подкастов и Apple (−16 LUFS)</option>
              <option value={-11}>Громко, для TikTok и Reels (−11 LUFS)</option>
              <option value={-23}>Для телевидения (−23 LUFS)</option>
              <option value={0}>Не менять</option>
            </select>
          </div>
        )}
        {(format === 'mp4' || format === 'mov') && (
          <div className="field" style={{ minWidth: 220 }}>
            <label>Чем считать</label>
            <select className="input" value={encoder} onChange={e => setEncoder(e.target.value as ExportOptions['encoder'])}>
              {(['auto', 'cpu', 'nvenc', 'qsv', 'amf'] as const).filter(e => e === 'auto' || e === 'cpu' || info?.encoders.includes(e)).map(e => <option key={e} value={e}>{ENCODER_LABEL[e]}</option>)}
            </select>
          </div>
        )}
      </div>
      {extraOk && otherFormats.length > 0 && (
        <div className="field">
          <label>Ещё и в других форматах <span className="small-text muted" style={{ marginLeft: 'auto' }}>видео подстроится под кадр, лицо останется в центре</span></label>
          <div className="row wrap">
            {otherFormats.map(f => (
              <button key={f.id} className={'chip' + (extra.includes(f.id) ? ' on' : '')} data-tip={f.hint}
                onClick={() => setExtra(x => (x.includes(f.id) ? x.filter(i => i !== f.id) : [...x, f.id]))}>
                {extra.includes(f.id) ? '✓ ' : ''}{f.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="field">
        <label>Куда сохранить</label>
        <div className="row">
          <input className="input" value={path} onChange={e => setPath(e.target.value)} />
          <button className="btn" onClick={pick}><FolderOpen size={15} /> Выбрать</button>
        </div>
      </div>
      {info?.encoders.length ? <div className="small-text muted">Найдено ускорение видеокартой: {info.encoders.map(e => ENCODER_LABEL[e]).join(', ')}. Сохранение пойдёт в несколько раз быстрее.</div> : null}
      {get().project!.media.some(m => m.missing) && <div className="warning-box"><TriangleAlert size={16} color="var(--warn)" /><div className="small-text">Некоторые файлы не найдены — их клипы будут пропущены.</div></div>}
    </Modal>
  );
}
