// Окна, появившиеся в 0.9: проверка перед публикацией, публикация, «собери ролик сам»,
// мультикамера и сообщение об ошибке с прошлого запуска.
import { useEffect, useState } from 'react';
import { AlertTriangle, Bug, History, CheckCircle2, Clapperboard, Copy, Eye, FileVideo, Info, Loader2, Send, ShieldCheck, Sparkles, Video, Wand2, X, XCircle } from 'lucide-react';
import { api, mediaUrl } from '../api';
import { formatTime } from '../../shared/timeline';
import { defaultPublish } from '../../shared/settings';
import type { Issue } from '../../shared/preflight';
import { set, toast, useStore } from '../state/store';
import { cancelPreflight, fixIssue, runPreflight, showIssue, usePreflight } from '../state/preflight';
import { PLATFORMS, publishVideo, refreshPublishStatus, suggestMeta, usePublish, type Platform } from '../state/publish';
import { cancelDraft, runDraft, useDraft, type DraftOptions } from '../state/draft';
import { createMulticam, MAX_ANGLES } from '../state/multicam';
import { copyReports, freshReports, sendReports, useCrash } from '../state/crash';
import { makeCover } from '../lib/cover';
import { restoreAutosave, type AutosaveInfo } from '../state/actions';
import { aiReady } from '../state/script';
import { Modal, Segmented, Switch } from './ui';

const close = () => set({ dialog: null });

// ── Проверка перед публикацией ──────────────────────
const LEVEL = {
  error: { icon: XCircle, color: 'var(--bad, #ff5c6c)', label: 'Важно' },
  warn: { icon: AlertTriangle, color: 'var(--warn)', label: 'Стоит поправить' },
  info: { icon: Info, color: 'var(--muted)', label: 'Для сведения' },
};

function IssueRow({ i }: { i: Issue }) {
  const L = LEVEL[i.level];
  const [busy, setBusy] = useState(false);
  return (
    <div className="issue">
      <L.icon size={16} color={L.color} style={{ flexShrink: 0, marginTop: 1 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{i.title}{i.time !== undefined && <span className="muted mono small-text"> · {formatTime(i.time)}</span>}</div>
        <div className="small-text muted">{i.detail}</div>
      </div>
      <div className="row" style={{ gap: 6, flexShrink: 0 }}>
        {(i.time !== undefined || i.clipId) && <button className="btn small ghost" onClick={() => showIssue(i)}><Eye size={13} /> Показать</button>}
        {i.fix && <button className="btn small" disabled={busy} onClick={async () => { setBusy(true); try { await fixIssue(i); } finally { setBusy(false); } }}><Wand2 size={13} /> {i.fix.label}</button>}
      </div>
    </div>
  );
}

export function PreflightDialog() {
  const st = usePreflight();
  useEffect(() => { if (!st.busy) runPreflight().catch(() => undefined); }, []);
  const issues = st.issues || [];
  const bad = issues.filter(i => i.level !== 'info');
  const done = !st.busy && st.at > 0;
  return (
    <Modal title="Проверка перед публикацией" icon={<ShieldCheck size={18} />} width={720} onClose={() => { if (st.busy) cancelPreflight(); close(); }}
      footer={<>
        {st.lufs !== undefined && <span className="small-text muted" style={{ marginRight: 'auto' }} data-tip="Громкость всего ролика. YouTube, ВК и Reels выравнивают около −14">Громкость: {st.lufs.toFixed(1)} LUFS</span>}
        <button className="btn ghost" disabled={st.busy} onClick={() => runPreflight().catch(() => undefined)}>Проверить ещё раз</button>
        <button className="btn" onClick={() => set({ dialog: 'export' })}>Сохранить видео</button>
        <button className="btn primary" onClick={() => set({ dialog: 'publish' })}><Send size={14} /> Опубликовать</button>
      </>}>
      <div className="col" style={{ gap: 12 }}>
        {st.busy && (
          <div className="card" style={{ gap: 6 }}>
            <div className="row"><Loader2 size={15} className="spin" /> {st.progress > 0 ? 'Просматриваю ролик целиком' : 'Смотрю проект'} <span className="spacer" />
              <button className="btn small ghost" onClick={cancelPreflight}>Остановить</button></div>
            <div className="progress"><div style={{ width: `${Math.round(st.progress * 100)}%` }} /></div>
            <div className="small-text muted">Программа прогоняет весь ролик в маленьком размере и слушает звук. Ролик на 10 минут проверяется примерно за минуту.</div>
          </div>
        )}
        {st.error && <div className="card small-text" style={{ color: 'var(--warn)' }}>Не удалось просмотреть ролик целиком: {st.error}</div>}
        {done && !bad.length && (
          <div className="card" style={{ alignItems: 'center', textAlign: 'center', padding: 22 }}>
            <CheckCircle2 size={34} color="var(--good)" />
            <b style={{ fontSize: 16 }}>Всё в порядке — можно публиковать</b>
            <span className="small-text muted">Громкость, надписи, звук и картинка проверены{st.analyzed ? ' по всему ролику' : ''}.</span>
          </div>
        )}
        {issues.length > 0 && <div className="issues">{issues.map(i => <IssueRow key={i.id} i={i} />)}</div>}
      </div>
    </Modal>
  );
}

// ── Публикация ──────────────────────────────────────
export function PublishDialog() {
  const project = useStore(s => s.project);
  const lastExport = useStore(s => s.lastExport);
  const pubSettings = { ...defaultPublish(), ...useStore(s => s.settings.publish) };
  const ps = usePublish();
  const [file, setFile] = useState(lastExport || '');
  const [size, setSize] = useState(-1);
  const [title, setTitle] = useState(project && project.name !== 'Новый проект' ? project.name : '');
  const [desc, setDesc] = useState('');
  const [tags, setTags] = useState('');
  const [cover, setCover] = useState<'none' | 'frame' | 'file'>('none');
  const [coverFile, setCoverFile] = useState('');
  const [privacy, setPrivacy] = useState(pubSettings.youtubePrivacy);
  const [targets, setTargets] = useState<Platform[]>([]);
  const [thinking, setThinking] = useState(false);
  useEffect(() => { refreshPublishStatus().then(() => setTargets(PLATFORMS.map(p => p.id).filter(id => usePublish.getState().status[id]))).catch(() => undefined); }, []);
  useEffect(() => { if (file) api.fileSize(file).then(setSize); else setSize(-1); }, [file]);
  // подсказка от ИИ-помощника
  useEffect(() => {
    const sg = ps.suggest;
    if (!sg) return;
    if (sg.title) setTitle(sg.title);
    if (sg.description) setDesc(sg.description);
    if (sg.tags?.length) setTags(sg.tags.join(', '));
    usePublish.setState({ suggest: undefined });
  }, [ps.suggest]);
  const connected = PLATFORMS.filter(p => ps.status[p.id]);
  const pick = async () => {
    const f: string[] = await api.openMediaDialog();
    const v = f.find(x => /\.(mp4|mov|webm|mkv|m4v)$/i.test(x));
    if (v) setFile(v); else if (f.length) toast('info', 'Выберите видеофайл (mp4, mov, webm)');
  };
  const ai = async () => {
    setThinking(true);
    try {
      const m = await suggestMeta();
      if (m.title) setTitle(m.title);
      if (m.description) setDesc(m.description);
      if (m.tags.length) setTags(m.tags.join(', '));
    } catch (e) {
      toast('error', 'Нейросеть не помогла', { detail: String((e as Error).message || e) });
    }
    setThinking(false);
  };
  const go = async () => {
    if (!file) { toast('info', 'Сначала выберите видео'); return; }
    if (!title.trim()) { toast('info', 'Напишите название'); return; }
    let coverPath: string | undefined;
    if (cover === 'file' && coverFile) coverPath = coverFile;
    if (cover === 'frame' && project) {
      try { coverPath = await makeCover({ title: title.slice(0, 40) }); } catch { /* без обложки */ }
    }
    await publishVideo({ file, title: title.trim(), description: desc, tags: tags.split(',').map(t => t.trim()).filter(Boolean), cover: coverPath, privacy }, targets);
  };
  const big = size > 50 * 1024 * 1024;
  return (
    <Modal title="Опубликовать видео" icon={<Send size={18} />} width={720} onClose={() => !ps.busy && close()}
      footer={<>
        <button className="btn ghost" style={{ marginRight: 'auto' }} onClick={() => set({ dialog: 'settings', settingsTab: 'publish' })}>Подключить площадки</button>
        <button className="btn ghost" disabled={ps.busy} onClick={close}>Закрыть</button>
        <button className="btn primary" disabled={ps.busy || !targets.length || !file} onClick={go}>{ps.busy ? <Loader2 size={14} className="spin" /> : <Send size={14} />} Опубликовать</button>
      </>}>
      <div className="col" style={{ gap: 12 }}>
        <div className="card" style={{ gap: 8 }}>
          <div className="row"><FileVideo size={15} /><b style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }} data-tip={file}>{file ? file.split(/[\\/]/).pop() : 'Видео не выбрано'}</b>
            {size > 0 && <span className="small-text muted">{(size / 1024 / 1024).toFixed(1)} МБ</span>}
            <button className="btn small ghost" onClick={pick}>Выбрать файл</button></div>
          {!file && <div className="small-text muted">Сначала сохраните видео (Ctrl+E) — оно появится здесь само. Или выберите готовый файл.</div>}
        </div>
        <div className="field"><label>Название <button className="btn small ghost" style={{ marginLeft: 'auto' }} disabled={thinking || !aiReady()} data-tip={aiReady() ? 'Нейросеть послушает ролик и предложит название, описание и теги' : 'Подключите нейросеть в настройках'} onClick={ai}>{thinking ? <Loader2 size={12} className="spin" /> : <Sparkles size={12} />} Придумать</button></label>
          <input className="input" value={title} maxLength={100} onChange={e => setTitle(e.target.value)} placeholder="Коротко и честно о главном" /></div>
        <div className="field"><label>Описание</label><textarea className="input" rows={4} value={desc} onChange={e => setDesc(e.target.value)} placeholder="Что зритель узнает из ролика. Ссылки, таймкоды" /></div>
        <div className="field"><label>Теги через запятую</label><input className="input" value={tags} onChange={e => setTags(e.target.value)} placeholder="монтаж, обзор, влог" /></div>
        <div className="field"><label>Обложка</label>
          <Segmented value={cover} onChange={setCover} options={[{ value: 'none', label: 'Без обложки' }, { value: 'frame', label: 'Кадр + название', tip: 'Кадр под линией времени и крупное название' }, { value: 'file', label: 'Своя картинка' }]} />
          {cover === 'file' && <div className="row"><span className="small-text muted" style={{ flex: 1 }}>{coverFile ? coverFile.split(/[\\/]/).pop() : 'не выбрана'}</span>
            <button className="btn small ghost" onClick={async () => { const f: string[] = await api.openMediaDialog(); const img = f.find(x => /\.(png|jpe?g|webp)$/i.test(x)); if (img) setCoverFile(img); }}>Выбрать</button></div>}
          {cover === 'file' && coverFile && <img src={mediaUrl(coverFile)} style={{ maxHeight: 90, alignSelf: 'flex-start', borderRadius: 8 }} />}
        </div>
        <div className="field"><label>Куда отправить</label>
          {connected.length === 0
            ? <div className="small-text muted">Пока ни одна площадка не подключена. Нажмите «Подключить площадки» внизу — это делается один раз.</div>
            : <div className="row wrap" style={{ gap: 6 }}>{PLATFORMS.map(p => {
                const on = targets.includes(p.id);
                return <button key={p.id} disabled={!ps.status[p.id]} className={'chip' + (on ? ' on' : '')} style={on ? { borderColor: p.color } : undefined}
                  data-tip={ps.status[p.id] ? undefined : 'Не подключено'} onClick={() => setTargets(on ? targets.filter(x => x !== p.id) : [...targets, p.id])}>{p.label}</button>;
              })}</div>}
          {targets.includes('youtube') && <Segmented value={privacy} onChange={setPrivacy} options={[{ value: 'private', label: 'YouTube: только я' }, { value: 'unlisted', label: 'по ссылке' }, { value: 'public', label: 'все' }]} />}
          {targets.includes('telegram') && big && <div className="small-text" style={{ color: 'var(--warn)' }}>Файл больше 50 МБ — Telegram его не примет. Сохраните видео поменьше (качество «Для соцсетей») или уберите Telegram.</div>}
        </div>
        {Object.keys(ps.progress).length > 0 && (
          <div className="card" style={{ gap: 6 }}>
            {(Object.keys(ps.progress) as Platform[]).map(id => {
              const pr = ps.progress[id]!;
              const r = ps.results?.find(x => x.platform === id);
              return (
                <div key={id} className="col" style={{ gap: 4 }}>
                  <div className="row small-text"><b>{PLATFORMS.find(x => x.id === id)!.label}</b><span className="spacer" />
                    {r ? (r.ok ? <a style={{ color: 'var(--good)', cursor: 'pointer' }} onClick={() => r.url && api.openExternal(r.url)}>готово{r.url ? ' — открыть' : ''}</a> : <span style={{ color: 'var(--warn)' }}>не получилось</span>)
                      : <span className="muted">{pr.text || `${Math.round(pr.k * 100)}%`}</span>}</div>
                  {!r && <div className="progress"><div style={{ width: `${Math.round(pr.k * 100)}%` }} /></div>}
                  {r && !r.ok && <div className="small-text muted">{r.error}</div>}
                  {r?.warning && <div className="small-text muted">{r.warning}</div>}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}

// ── «Собери ролик сам» ──────────────────────────────
export function DraftDialog() {
  const project = useStore(s => s.project)!;
  const cache = useStore(s => s.mediaCache);
  const d = useDraft();
  const visual = project.media.filter(m => (m.kind === 'video' || m.kind === 'image') && !m.missing);
  const music = project.media.filter(m => m.kind === 'audio' && !m.missing);
  const [ids, setIds] = useState<string[]>(visual.map(m => m.id));
  const [request, setRequest] = useState('');
  const [target, setTarget] = useState('60');
  const [format, setFormat] = useState<DraftOptions['format']>(project.height > project.width ? 'vertical' : 'project');
  const [subs, setSubs] = useState(true);
  const [title, setTitle] = useState(true);
  const [musicId, setMusicId] = useState(music[0]?.id || '');
  const go = async () => {
    const plan = await runDraft({ mediaIds: ids, request, target: Number(target), format, subtitles: subs, title, musicId: musicId || undefined });
    if (plan) close();
  };
  return (
    <Modal title="Собери ролик сам" icon={<Wand2 size={18} />} width={760} onClose={() => { if (d.busy) cancelDraft(); close(); }}
      footer={<>
        <span className="small-text muted" style={{ marginRight: 'auto' }}>{aiReady() ? 'Нейросеть выберет лучшие куски по смыслу речи' : 'Без нейросети — простой черновик по порядку'}</span>
        <button className="btn ghost" onClick={() => { if (d.busy) cancelDraft(); close(); }}>{d.busy ? 'Остановить' : 'Отмена'}</button>
        <button className="btn primary" disabled={d.busy || !ids.length} onClick={go}>{d.busy ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} Собрать черновик</button>
      </>}>
      <div className="col" style={{ gap: 12 }}>
        <div className="small-text muted">Отметьте сырые записи и напишите, какой ролик нужен. Программа распознает речь, выберет лучшие моменты, поставит их по порядку, добавит субтитры, заголовок и музыку. Потом всё можно поправить вручную.</div>
        {visual.length === 0 ? <div className="card small-text">В медиатеке пока нет видео. Добавьте записи (Ctrl+I) и откройте это окно снова.</div> : (
          <div className="draft-grid">
            {visual.map(m => {
              const on = ids.includes(m.id);
              const th = cache[m.id]?.thumb;
              return (
                <button key={m.id} className={'draft-item' + (on ? ' on' : '')} onClick={() => setIds(on ? ids.filter(x => x !== m.id) : [...ids, m.id])}>
                  <div className="thumb" style={{ backgroundImage: th ? `url("${mediaUrl(th)}")` : undefined }} />
                  <span>{m.name}</span>
                  <small className="muted">{m.kind === 'image' ? 'фото' : formatTime(m.duration)}{m.transcript ? ' · речь есть' : ''}</small>
                </button>
              );
            })}
          </div>
        )}
        <div className="field"><label>Что должно получиться</label>
          <textarea className="input" rows={3} value={request} onChange={e => setRequest(e.target.value)} placeholder="Например: короткий ролик для Reels про ремонт кухни — самое интересное, без пауз и оговорок, с сильным началом" /></div>
        <div className="row wrap" style={{ gap: 14 }}>
          <div className="field"><label>Длина</label><Segmented value={target} onChange={setTarget} options={[{ value: '15', label: '15 с' }, { value: '30', label: '30 с' }, { value: '60', label: '1 мин' }, { value: '180', label: '3 мин' }, { value: '600', label: '10 мин' }]} /></div>
          <div className="field"><label>Формат</label><Segmented value={format} onChange={setFormat} options={[{ value: 'project', label: 'Как сейчас' }, { value: 'vertical', label: '9:16' }, { value: 'wide', label: '16:9' }, { value: 'square', label: '1:1' }]} /></div>
        </div>
        <div className="row wrap" style={{ gap: 18 }}>
          <Switch label="Субтитры" checked={subs} onChange={setSubs} />
          <Switch label="Заголовок в начале" checked={title} onChange={setTitle} />
          <div className="field" style={{ minWidth: 220 }}><label>Музыка</label>
            <select className="input" value={musicId} onChange={e => setMusicId(e.target.value)}>
              <option value="">Без музыки</option>
              {music.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select></div>
        </div>
        {d.busy && <div className="card row"><Loader2 size={15} className="spin" /> {d.step || 'Работаю'}…</div>}
      </div>
    </Modal>
  );
}

// ── Мультикамера ────────────────────────────────────
export function MulticamDialog() {
  const project = useStore(s => s.project)!;
  const cache = useStore(s => s.mediaCache);
  const videos = project.media.filter(m => m.kind === 'video' && !m.missing);
  const [ids, setIds] = useState<string[]>(() => videos.slice(0, Math.min(MAX_ANGLES, videos.length)).map(v => v.id));
  const [audio, setAudio] = useState(0);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { await createMulticam(ids, { audio }); close(); } catch { /* сообщение уже показано */ }
    setBusy(false);
  };
  return (
    <Modal title="Мультикамера" icon={<Video size={18} />} width={680} onClose={close}
      footer={<>
        <button className="btn ghost" onClick={close}>Отмена</button>
        <button className="btn primary" disabled={busy || ids.length < 2} onClick={go}>{busy ? <Loader2 size={14} className="spin" /> : <Clapperboard size={14} />} Собрать и выровнять по звуку</button>
      </>}>
      <div className="col" style={{ gap: 12 }}>
        <div className="small-text muted">Снимали одно и то же с двух-трёх камер или телефонов? Отметьте записи по порядку: первая — главная камера. Программа сама выровняет их по звуку, а потом при просмотре клавиши 1, 2, 3 переключают камеры, как у режиссёра трансляции.</div>
        {videos.length < 2 ? <div className="card small-text">Нужно хотя бы два видео в медиатеке.</div> : (
          <div className="draft-grid">
            {videos.map(m => {
              const n = ids.indexOf(m.id);
              const th = cache[m.id]?.thumb;
              return (
                <button key={m.id} className={'draft-item' + (n >= 0 ? ' on' : '')}
                  onClick={() => setIds(n >= 0 ? ids.filter(x => x !== m.id) : ids.length < MAX_ANGLES ? [...ids, m.id] : ids)}>
                  <div className="thumb" style={{ backgroundImage: th ? `url("${mediaUrl(th)}")` : undefined }}>{n >= 0 && <b className="cam-num">{n + 1}</b>}</div>
                  <span>{m.name}</span>
                  <small className="muted">{formatTime(m.duration)}{m.hasAudio ? '' : ' · без звука'}</small>
                </button>
              );
            })}
          </div>
        )}
        {ids.length >= 2 && (
          <div className="field"><label>Звук брать</label>
            <select className="input" value={audio} onChange={e => setAudio(Number(e.target.value))}>
              {ids.map((_, i) => <option key={i} value={i}>С камеры {i + 1}</option>)}
              <option value={-1}>С той камеры, что в кадре</option>
            </select>
            <span className="small-text muted">Обычно лучше один хороший микрофон на весь ролик — тогда звук не скачет при смене камеры.</span>
          </div>
        )}
        <div className="small-text muted">Совет на будущее: хлопните в ладоши в начале съёмки — по такому звуку камеры выравниваются точнее всего.</div>
      </div>
    </Modal>
  );
}

// ── Сообщение об ошибке с прошлого запуска ──────────
export function CrashNotice() {
  const st = useCrash();
  const url = useStore(s => s.settings.reports?.url);
  const projectId = useStore(s => s.project?.id);
  const [saved, setSaved] = useState<AutosaveInfo | null>(null);
  const fresh = freshReports(st);
  const show = st.loaded && !st.dismissed && (fresh.length > 0 || st.unclean);
  useEffect(() => { if (show && st.unclean) api.autosaves().then((a: AutosaveInfo[]) => setSaved(a[0] || null)).catch(() => undefined); }, [show, st.unclean]);
  if (!show) return null;
  const hide = () => useCrash.setState({ dismissed: true });
  const canRestore = saved && saved.id !== projectId;
  return (
    <div className="crash-notice">
      <Bug size={18} color="var(--warn)" style={{ flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <b>{st.unclean ? 'В прошлый раз программа закрылась неожиданно' : 'В прошлый раз что-то пошло не так'}</b>
        <div className="small-text muted">
          {canRestore ? `Работа «${saved.name}» сохранилась автоматически ${ago(saved.savedAt)} — её можно восстановить. ` : st.unclean && !saved ? 'Несохранённой работы не нашлось. ' : ''}
          {fresh.length ? 'Отчёт об ошибке готов: отправьте его разработчику, и её исправят быстрее. Ваших видео и ключей в нём нет.' : ''}
        </div>
        {(fresh.length > 0 || canRestore) && (
          <div className="row wrap" style={{ marginTop: 6 }}>
            {canRestore && <button className="btn small primary" onClick={async () => { if (await restoreAutosave(saved)) hide(); }}><History size={13} /> Восстановить работу</button>}
            {fresh.length > 0 && url && <button className={'btn small' + (canRestore ? '' : ' primary')} onClick={() => { sendReports(fresh.map(r => r.id)); hide(); }}><Send size={13} /> Отправить отчёт</button>}
            {fresh.length > 0 && <button className="btn small" onClick={() => copyReports(fresh.map(r => r.id))}><Copy size={13} /> Скопировать отчёт</button>}
          </div>
        )}
      </div>
      <button className="icon-btn small" onClick={hide} data-tip="Скрыть"><X size={14} /></button>
    </div>
  );
}

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'только что' : m < 60 ? `${m} мин назад` : m < 60 * 24 ? `${Math.round(m / 60)} ч назад` : new Date(t).toLocaleDateString('ru-RU');
};
