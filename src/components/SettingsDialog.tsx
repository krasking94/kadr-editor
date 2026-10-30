// Настройки: оформление, нейросети (ключи и модели), MCP, экспорт, клавиши, о программе.
import { useEffect, useState } from 'react';
import { AudioLines, Bot, CheckCircle2, Copy, Cpu, ExternalLink, ImagePlus, Info, Keyboard, KeyRound, Loader2, Palette, Play, Plug, Plus, RefreshCw, Server, Settings as Gear, Trash2 } from 'lucide-react';
import { ELEVEN_TTS_MODELS, IMAGE_PROVIDERS, imageProvider, type Voice } from '../../shared/generators';
import { api } from '../api';
import { PROVIDERS, providerPreset, SPEECH_PROVIDERS } from '../../shared/providers';
import type { McpClientConfig } from '../../shared/settings';
import { uid } from '../../shared/timeline';
import { set, toast, useStore } from '../state/store';
import { saveSecret, saveSettings } from '../state/settings-actions';
import { Modal, Segmented, Slider, Switch } from './ui';
import { ShortcutsList } from './ShortcutsDialog';
import { Logo } from './Logo';

const NAV = [
  { id: 'general', label: 'Общие', icon: Palette },
  { id: 'ai', label: 'Нейросети', icon: Bot },
  { id: 'gen', label: 'Картинки и звук', icon: ImagePlus },
  { id: 'mcp', label: 'Внешний ИИ (MCP)', icon: Plug },
  { id: 'export', label: 'Сохранение видео', icon: Cpu },
  { id: 'keys', label: 'Горячие клавиши', icon: Keyboard },
  { id: 'about', label: 'О программе', icon: Info },
];

export function SettingsDialog() {
  const tab = useStore(s => s.settingsTab);
  return (
    <Modal title="Настройки" icon={<Gear size={18} />} width={940} onClose={() => set({ dialog: null })}>
      <div className="settings-layout" style={{ margin: -18 }}>
        <div className="settings-nav">
          {NAV.map(n => <button key={n.id} className={tab === n.id ? 'on' : ''} onClick={() => set({ settingsTab: n.id })}><n.icon size={15} />{n.label}</button>)}
        </div>
        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16, overflow: 'auto', maxHeight: 'calc(100vh - 180px)' }}>
          {tab === 'general' && <General />}
          {tab === 'ai' && <AiSettings />}
          {tab === 'gen' && <GenSettings />}
          {tab === 'mcp' && <McpSettings />}
          {tab === 'export' && <ExportSettings />}
          {tab === 'keys' && <ShortcutsList />}
          {tab === 'about' && <About />}
        </div>
      </div>
    </Modal>
  );
}

function CopyBox({ text }: { text: string }) {
  return (
    <div className="code-box">
      <span style={{ whiteSpace: 'pre-wrap' }}>{text}</span>
      <button className="icon-btn small" data-tip="Скопировать" onClick={() => { navigator.clipboard.writeText(text); toast('success', 'Скопировано'); }}><Copy size={13} /></button>
    </div>
  );
}

function General() {
  const s = useStore(st => st.settings);
  const ACCENTS = ['#7c5cff', '#3a7bff', '#14b8a6', '#22c55e', '#f59e0b', '#ff5c8a', '#ef4444'];
  return (
    <>
      <div className="field"><label>Тема</label>
        <Segmented value={s.theme} onChange={v => saveSettings({ theme: v })} options={[{ value: 'dark', label: 'Тёмная' }, { value: 'light', label: 'Светлая' }, { value: 'system', label: 'Как в Windows' }]} />
      </div>
      <div className="field"><label>Цвет акцента</label>
        <div className="row">
          {ACCENTS.map(c => <button key={c} onClick={() => saveSettings({ accent: c })} style={{ width: 28, height: 28, borderRadius: 8, background: c, cursor: 'pointer', border: s.accent === c ? '2px solid var(--text)' : '1px solid var(--line-2)' }} />)}
          <label className="color-swatch" style={{ background: s.accent, width: 28, height: 28 }}><input type="color" value={s.accent} onChange={e => saveSettings({ accent: e.target.value })} /></label>
        </div>
      </div>
      <Slider label="Автосохранение (минут)" value={s.autosaveMinutes} min={0} max={15} step={1} def={2} format={v => (v ? `каждые ${v} мин` : 'выключено')} onChange={v => saveSettings({ autosaveMinutes: v })}
        hint="Копия проекта на случай сбоя. Её можно восстановить на стартовом экране." />
      <Switch label="Прилипание клипов на таймлайне" checked={s.snapping} onChange={v => saveSettings({ snapping: v })} />
      <Switch label="Показывать подсказки для новичков" checked={s.showTips} onChange={v => saveSettings({ showTips: v })} />
    </>
  );
}

function AiSettings() {
  const s = useStore(st => st.settings);
  const secrets = useStore(st => st.secrets);
  const [selected, setSelected] = useState(s.ai.provider);
  const preset = providerPreset(selected);
  const saved = s.ai.providers[preset.id] || { baseUrl: '', model: '' };
  const [key, setKey] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => { setKey(''); setModels([]); }, [selected]);
  const setProv = (patch: Partial<{ baseUrl: string; model: string }>) => saveSettings({ ai: { ...s.ai, providers: { ...s.ai.providers, [preset.id]: { baseUrl: saved.baseUrl, model: saved.model, ...patch } } } });
  const loadModels = async () => {
    setLoading(true);
    try {
      const list = await api.aiModels(preset.id, saved.baseUrl || undefined);
      setModels(list);
      toast('success', `Найдено моделей: ${list.length}`);
    } catch (e) {
      toast('error', 'Не удалось получить список моделей', { detail: String((e as Error).message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') });
    }
    setLoading(false);
  };
  return (
    <>
      <div className="tip-card"><KeyRound size={18} color="var(--accent)" style={{ flex: 'none' }} />
        <div><b>Как это работает.</b> Нейросеть живёт на сайте компании, а «Кадр» общается с ней через ключ — это длинный пароль из личного кабинета. Ключ хранится на вашем компьютере в зашифрованном виде и никуда больше не отправляется. Ollama и LM Studio работают прямо на компьютере, без ключа и интернета.</div>
      </div>
      <div className="provider-list">
        {PROVIDERS.map(p => (
          <button key={p.id} className={'provider' + (selected === p.id ? ' on' : '')} onClick={() => setSelected(p.id)}>
            {p.label}{s.ai.provider === p.id && <span className="badge accent" style={{ marginLeft: 6 }}>основная</span>}
            <span className={'k' + (!p.needsKey || secrets[p.id] ? ' ok' : '')} data-tip={!p.needsKey ? 'Ключ не нужен' : secrets[p.id] ? 'Ключ сохранён' : 'Нет ключа'} />
          </button>
        ))}
      </div>
      <div className="card">
        <div className="row"><b style={{ fontSize: 14 }}>{preset.label}</b><div className="spacer" />
          {s.ai.provider !== preset.id
            ? <button className="btn primary small" onClick={() => { saveSettings({ ai: { ...s.ai, provider: preset.id } }); toast('success', `Помощник теперь работает на «${preset.label}»`); }}>Сделать основной</button>
            : <span className="badge accent">помощник работает на ней</span>}
        </div>
        {preset.hint && <div className="small-text muted">{preset.hint}</div>}
        {preset.needsKey && (
          <div className="field">
            <label>Ключ API {secrets[preset.id] ? <span style={{ color: 'var(--good)' }}>● сохранён</span> : <span style={{ color: 'var(--warn)' }}>● нет ключа</span>}
              {preset.keyUrl && <a style={{ cursor: 'pointer', color: 'var(--accent)' }} onClick={() => api.openExternal(preset.keyUrl!)}>Где взять ключ <ExternalLink size={11} /></a>}
            </label>
            <div className="row">
              <input className="input" type="password" value={key} placeholder={secrets[preset.id] ? '•••••••• (вставьте новый, чтобы заменить)' : 'Вставьте ключ сюда (Ctrl+V)'} onChange={e => setKey(e.target.value)} />
              <button className="btn primary" disabled={!key.trim()} onClick={async () => { await saveSecret(preset.id, key.trim()); setKey(''); toast('success', 'Ключ сохранён'); }}>Сохранить</button>
              {secrets[preset.id] && <button className="btn ghost" data-tip="Удалить ключ" onClick={() => saveSecret(preset.id, '')}><Trash2 size={14} /></button>}
            </div>
          </div>
        )}
        <div className="field">
          <label>Модель <span className="muted">по умолчанию: {preset.model || '—'}</span></label>
          <div className="row">
            <input className="input mono" list={'models-' + preset.id} value={saved.model} placeholder={preset.model} onChange={e => setProv({ model: e.target.value })} />
            <button className="btn" onClick={loadModels} disabled={loading}><RefreshCw size={14} className={loading ? 'spin' : ''} /> Список</button>
          </div>
          <datalist id={'models-' + preset.id}>{models.map(m => <option key={m} value={m} />)}</datalist>
          {models.length > 0 && <div className="row wrap" style={{ gap: 4, maxHeight: 120, overflow: 'auto' }}>{models.slice(0, 60).map(m => <button key={m} className="chip mono" style={{ fontSize: 11 }} onClick={() => setProv({ model: m })}>{m}</button>)}</div>}
        </div>
        <div className="field">
          <label>Адрес сервиса <span className="muted">менять не нужно, если вы не знаете зачем</span></label>
          <input className="input mono" value={saved.baseUrl} placeholder={preset.baseUrl} onChange={e => setProv({ baseUrl: e.target.value })} />
        </div>
        <div className="small-text muted">{preset.vision ? 'Эта нейросеть умеет смотреть кадры вашего видео.' : 'Эта нейросеть не видит картинки, но может монтировать по описанию проекта.'}</div>
      </div>
      <div className="card">
        <b>Распознавание речи (для субтитров)</b>
        <div className="row wrap" style={{ alignItems: 'flex-end' }}>
          <div className="field grow"><label>Сервис</label>
            <select className="input" value={s.ai.speechProvider} onChange={e => saveSettings({ ai: { ...s.ai, speechProvider: e.target.value, speechModel: providerPreset(e.target.value).speechModel || s.ai.speechModel } })}>
              {SPEECH_PROVIDERS.map(id => <option key={id} value={id}>{providerPreset(id).label}{providerPreset(id).needsKey && !secrets[id] ? ' — нужен ключ' : ''}</option>)}
            </select>
          </div>
          <div className="field grow"><label>Модель</label><input className="input mono" value={s.ai.speechModel} onChange={e => saveSettings({ ai: { ...s.ai, speechModel: e.target.value } })} /></div>
          <div className="field" style={{ width: 110 }}><label>Язык</label>
            <select className="input" value={s.ai.speechLanguage} onChange={e => saveSettings({ ai: { ...s.ai, speechLanguage: e.target.value } })}>
              {[['ru', 'Русский'], ['en', 'English'], ['uk', 'Українська'], ['kk', 'Қазақша'], ['de', 'Deutsch'], ['', 'Авто']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
        </div>
        <div className="small-text muted">Ключ для распознавания берётся из того же сервиса выше. Groq даёт бесплатный лимит.</div>
      </div>
    </>
  );
}

/** Поле ключа: показывает, сохранён ли он, и где его взять */
function KeyField({ id, url, label = 'Ключ API' }: { id: string; url?: string; label?: string }) {
  const secrets = useStore(st => st.secrets);
  const [key, setKey] = useState('');
  return (
    <div className="field">
      <label>{label} {secrets[id] ? <span style={{ color: 'var(--good)' }}>● сохранён</span> : <span style={{ color: 'var(--warn)' }}>● нет ключа</span>}
        {url && <a style={{ cursor: 'pointer', color: 'var(--accent)' }} onClick={() => api.openExternal(url)}>Где взять ключ <ExternalLink size={11} /></a>}
      </label>
      <div className="row">
        <input className="input" type="password" value={key} placeholder={secrets[id] ? '•••••••• (вставьте новый, чтобы заменить)' : 'Вставьте ключ сюда (Ctrl+V)'} onChange={e => setKey(e.target.value)} />
        <button className="btn primary" disabled={!key.trim()} onClick={async () => { await saveSecret(id, key.trim()); setKey(''); toast('success', 'Ключ сохранён'); }}>Сохранить</button>
        {secrets[id] && <button className="btn ghost" data-tip="Удалить ключ" onClick={() => saveSecret(id, '')}><Trash2 size={14} /></button>}
      </div>
    </div>
  );
}

function GenSettings() {
  const s = useStore(st => st.settings);
  const secrets = useStore(st => st.secrets);
  const g = s.gen;
  const save = (patch: Partial<typeof g>) => saveSettings({ gen: { ...g, ...patch } });
  const p = imageProvider(g.imageProvider);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [loading, setLoading] = useState(false);
  const loadVoices = async () => {
    setLoading(true);
    try { setVoices(await api.genVoices()); } catch (e) { toast('error', 'Не удалось получить голоса', { detail: String((e as Error).message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }); }
    setLoading(false);
  };
  useEffect(() => { if (secrets.elevenlabs) loadVoices(); }, [!!secrets.elevenlabs]);
  const preview = (url?: string) => { if (url) new Audio(url).play().catch(() => undefined); };
  return (
    <>
      <div className="tip-card"><ImagePlus size={18} color="var(--accent)" style={{ flex: 'none' }} />
        <div><b>Создание прямо в «Кадре».</b> Вкладка <b>«Создать»</b> слева рисует картинки, озвучивает текст, делает звуки и музыку и сразу кладёт их на таймлайн. Это же умеют встроенный помощник и Claude по MCP: просто попросите. Готовые файлы сохраняются в папку «Документы → Кадр → Сгенерировано».</div>
      </div>
      <div className="card">
        <div className="row"><ImagePlus size={16} /><b>Картинки</b></div>
        <div className="provider-list">
          {IMAGE_PROVIDERS.map(x => (
            <button key={x.id} className={'provider' + (g.imageProvider === x.id ? ' on' : '')} onClick={() => save({ imageProvider: x.id })}>
              {x.label}
              <span className={'k' + (secrets[x.keyId] || x.id === 'custom-image' ? ' ok' : '')} data-tip={secrets[x.keyId] ? 'Ключ сохранён' : 'Нет ключа'} />
            </button>
          ))}
        </div>
        {p.hint && <div className="small-text muted">{p.hint}</div>}
        <div className="small-text">Цена: <b>{p.price}</b>. Платите самому сервису, «Кадр» ничего не берёт.</div>
        {(p.keyId === 'openai' || p.keyId === 'gemini') && <div className="small-text muted">Ключ общий с помощником: если вы уже вставили его на вкладке «Нейросети», ничего делать не нужно.</div>}
        <KeyField id={p.keyId} url={p.keyUrl} />
        {p.id === 'custom-image' && (
          <div className="field"><label>Адрес сервиса</label>
            <input className="input mono" value={g.imageBaseUrl} placeholder={p.baseUrl} onChange={e => save({ imageBaseUrl: e.target.value })} />
          </div>
        )}
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="field grow"><label>Модель <span className="muted">по умолчанию: {p.model || '—'}</span></label>
            <input className="input mono" value={g.imageModels[p.id] || ''} placeholder={p.model} onChange={e => save({ imageModels: { ...g.imageModels, [p.id]: e.target.value.trim() } })} />
          </div>
          <div className="field"><label>Пропорции</label>
            <select className="input" value={g.imageAspect} onChange={e => save({ imageAspect: e.target.value })}>
              <option value="auto">Как у проекта</option>
              {['16:9', '9:16', '1:1', '4:3', '3:4'].map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
        </div>
      </div>
      <div className="card">
        <div className="row"><AudioLines size={16} /><b>Голос, звуки и музыка — ElevenLabs</b></div>
        <div className="small-text muted">Озвучка текста живыми голосами (в том числе вашими клонами), звуковые эффекты по описанию и музыка без авторских прав. Расходует кредиты вашей подписки ElevenLabs: голос — по количеству букв, звуки и музыка — по длительности.</div>
        <KeyField id="elevenlabs" url="https://elevenlabs.io/app/settings/api-keys" />
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="field grow"><label>Голос по умолчанию</label>
            <div className="row">
              <select className="input" value={g.voiceId} onChange={e => { const v = voices.find(x => x.id === e.target.value); save({ voiceId: e.target.value, voiceName: v?.name || '' }); }}>
                <option value="">{voices.length ? 'Первый из списка' : g.voiceName || (secrets.elevenlabs ? 'Загрузите голоса' : 'Сначала вставьте ключ')}</option>
                {voices.map(v => <option key={v.id} value={v.id}>{v.name}{v.info ? ` — ${v.info}` : ''}</option>)}
              </select>
              <button className="icon-btn" data-tip="Послушать" disabled={!voices.find(v => v.id === g.voiceId)?.preview} onClick={() => preview(voices.find(v => v.id === g.voiceId)?.preview)}><Play size={14} /></button>
              <button className="btn" onClick={loadVoices} disabled={loading || !secrets.elevenlabs}><RefreshCw size={14} className={loading ? 'spin' : ''} /> Голоса</button>
            </div>
          </div>
          <div className="field"><label>Модель речи</label>
            <select className="input" value={g.ttsModel} onChange={e => save({ ttsModel: e.target.value })}>
              {ELEVEN_TTS_MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </div>
        </div>
      </div>
    </>
  );
}

type DesktopStatus = { installed: boolean; connected: boolean; outdated: boolean; files: string[] };

/** Claude Desktop в один клик: «Кадр» сам прописывает себя в настройках Claude, Node.js не нужен */
function ClaudeDesktopCard({ port, serverOn, lastClient }: { port: number; serverOn: boolean; lastClient?: string }) {
  const [st, setSt] = useState<DesktopStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [justDone, setJustDone] = useState(false);
  const [manual, setManual] = useState(false);
  const [entry, setEntry] = useState<unknown>(null);
  const load = () => api.mcpDesktopStatus().then(setSt).catch(() => undefined);
  useEffect(() => { load(); }, [port]);
  useEffect(() => { if (manual) api.mcpDesktopEntry().then(setEntry); }, [manual, port]);
  const connect = async () => {
    setBusy(true);
    const r = await api.mcpDesktopConnect().catch(e => ({ ok: false, files: [], error: String(e) }));
    setBusy(false);
    if (r.ok) { setJustDone(true); toast('success', 'Claude Desktop подключён', { detail: 'Перезапустите Claude, чтобы он увидел «Кадр»' }); }
    else toast('error', 'Не получилось подключить', { detail: r.error });
    load();
  };
  const seen = !!lastClient && /claude/i.test(lastClient);
  return (
    <div className="card">
      <div className="row"><Bot size={16} /><b>Claude Desktop</b>
        <span className={'dot' + (st?.connected ? ' on' : '')} style={{ marginLeft: 6 }} />
        <span className="small-text muted">{st?.connected ? (seen ? 'подключён и уже заходил' : 'подключён') : st?.outdated ? 'нужно обновить подключение' : st?.installed ? 'не подключён' : 'не найден на компьютере'}</span>
        <div className="spacer" />
        <button className={'btn small' + (st?.connected ? '' : ' primary')} disabled={busy} onClick={connect}>
          {busy ? <Loader2 size={13} className="spin" /> : st?.connected ? <RefreshCw size={13} /> : <Plug size={13} />}
          {st?.connected ? 'Подключить заново' : 'Подключить'}
        </button>
      </div>
      <div className="small-text muted">Работает по вашей обычной подписке Claude, ключ API и Node.js не нужны. «Кадр» сам впишет себя в настройки Claude Desktop.</div>
      {(justDone || (st?.connected && !seen)) && (
        <div className="tip-card"><CheckCircle2 size={18} color="var(--good, #22c55e)" style={{ flex: 'none' }} />
          <div><b>Остался один шаг:</b> полностью закройте Claude — значок у часов внизу справа → правая кнопка → <b>Выход</b>, — и откройте снова. Потом напишите ему: «Что сейчас открыто в Кадре?»{!serverOn && <> Сервер «Кадра» ниже сейчас выключен — включите его.</>}</div>
        </div>
      )}
      {st && !st.installed && <div className="small-text muted">Скачать Claude Desktop: <a href="https://claude.ai/download" target="_blank" rel="noreferrer">claude.ai/download</a>. После установки нажмите «Подключить».</div>}
      <button className="btn ghost small" style={{ alignSelf: 'flex-start' }} onClick={() => setManual(v => !v)}>{manual ? 'Скрыть' : 'Показать'} настройку для ручного ввода</button>
      {manual && !!entry && <>
        <div className="small-text muted">Файл: {st?.files[0] || 'claude_desktop_config.json'}</div>
        <CopyBox text={JSON.stringify({ mcpServers: { kadr: entry } }, null, 2)} />
      </>}
    </div>
  );
}

function McpSettings() {
  const s = useStore(st => st.settings);
  const [status, setStatus] = useState<{ server: { running: boolean; port: number; error?: string; lastClient?: string }; clients: { id: string; status: string; error?: string; tools: string[] }[] } | null>(null);
  const [draft, setDraft] = useState<McpClientConfig>({ id: '', name: '', type: 'stdio', command: '', args: [], url: '', enabled: true });
  const [port, setPort] = useState(s.mcp.port);
  const load = () => api.mcpStatus().then(setStatus).catch(() => undefined);
  useEffect(() => { load(); const off = api.onMcpClients(load); const t = setInterval(load, 4000); return () => { off(); clearInterval(t); }; }, []);
  const url = `http://127.0.0.1:${s.mcp.port}/mcp`;
  const saveClients = (clients: McpClientConfig[]) => saveSettings({ mcp: { ...s.mcp, clients } }).then(() => setTimeout(load, 800));
  return (
    <>
      <div className="tip-card"><Plug size={18} color="var(--accent)" style={{ flex: 'none' }} />
        <div><b>MCP</b> — общий «язык», на котором нейросети управляют программами. Включите сервер, и Claude, Cursor или другой ИИ на вашем компьютере смогут монтировать в «Кадре»: вы будете видеть каждое их действие и сможете отменить его.</div>
      </div>
      <ClaudeDesktopCard port={s.mcp.port} serverOn={!!status?.server.running} lastClient={status?.server.lastClient} />
      <div className="card">
        <div className="row"><Server size={16} /><b>Сервер «Кадра»</b>
          <span className={'dot' + (status?.server.running ? ' on' : status?.server.error ? ' bad' : '')} style={{ marginLeft: 6 }} />
          <span className="small-text muted">{status?.server.running ? 'работает' : status?.server.error || 'выключен'}</span>
          <div className="spacer" />
          <Switch checked={s.mcp.serverEnabled} onChange={v => saveSettings({ mcp: { ...s.mcp, serverEnabled: v } }).then(load)} />
        </div>
        <div className="row">
          <span className="small-text muted">Порт</span>
          <input className="input mono" style={{ width: 90 }} type="number" value={port} onChange={e => setPort(Number(e.target.value))} />
          <button className="btn small" disabled={port === s.mcp.port || port < 1024 || port > 65535} onClick={() => saveSettings({ mcp: { ...s.mcp, port } }).then(load)}>Применить</button>
          {status?.server.lastClient && <span className="badge accent" style={{ marginLeft: 'auto' }}>подключался: {status.server.lastClient}</span>}
        </div>
        <div className="small-text muted">Адрес для подключения (работает только на этом компьютере):</div>
        <CopyBox text={url} />
        <div className="small-text muted"><b>Claude Code</b> — выполните в терминале:</div>
        <CopyBox text={`claude mcp add --transport http kadr ${url}`} />
        <div className="small-text muted"><b>Cursor, VS Code и другие</b> — в настройках MCP:</div>
        <CopyBox text={JSON.stringify({ mcpServers: { kadr: { url } } }, null, 2)} />
      </div>
      <div className="card">
        <div className="row"><Plug size={16} /><b>Подключить инструменты к помощнику</b></div>
        <div className="small-text muted">Обратная сторона: ваш ИИ-помощник может пользоваться чужими MCP-серверами — например, поиском картинок или генерацией музыки. Их инструменты появятся у помощника автоматически.</div>
        {s.mcp.clients.map(c => {
          const st = status?.clients.find(x => x.id === c.id);
          return (
            <div key={c.id} className="row" style={{ padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 9 }}>
              <span className={'dot' + (st?.status === 'ready' ? ' on' : st?.status === 'error' ? ' bad' : '')} />
              <div className="grow">
                <b>{c.name}</b> <span className="muted small-text mono">{c.type === 'http' ? c.url : [c.command, ...(c.args || [])].join(' ')}</span>
                <div className="small-text muted">{st?.status === 'ready' ? `инструментов: ${st.tools.length}` : st?.status === 'error' ? st.error : st?.status === 'connecting' ? 'подключаюсь…' : 'выключен'}</div>
              </div>
              <Switch checked={c.enabled} onChange={v => saveClients(s.mcp.clients.map(x => (x.id === c.id ? { ...x, enabled: v } : x)))} />
              <button className="icon-btn small" onClick={() => saveClients(s.mcp.clients.filter(x => x.id !== c.id))} data-tip="Удалить"><Trash2 size={13} /></button>
            </div>
          );
        })}
        <div className="row wrap" style={{ alignItems: 'flex-end' }}>
          <div className="field" style={{ width: 140 }}><label>Название</label><input className="input" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="Например, Поиск" /></div>
          <div className="field"><label>Тип</label><Segmented value={draft.type} onChange={v => setDraft({ ...draft, type: v })} options={[{ value: 'stdio', label: 'Программа' }, { value: 'http', label: 'Адрес' }]} /></div>
          {draft.type === 'stdio'
            ? <div className="field grow"><label>Команда</label><input className="input mono" value={[draft.command, ...(draft.args || [])].join(' ').trim()} onChange={e => { const [command, ...args] = e.target.value.split(' '); setDraft({ ...draft, command, args }); }} placeholder="npx -y @modelcontextprotocol/server-everything" /></div>
            : <div className="field grow"><label>Адрес</label><input className="input mono" value={draft.url} onChange={e => setDraft({ ...draft, url: e.target.value })} placeholder="http://localhost:3000/mcp" /></div>}
          <button className="btn primary" disabled={!draft.name.trim() || (draft.type === 'stdio' ? !draft.command : !draft.url)}
            onClick={() => { saveClients([...s.mcp.clients, { ...draft, id: uid('mcp'), name: draft.name.trim() }]); setDraft({ id: '', name: '', type: 'stdio', command: '', args: [], url: '', enabled: true }); }}>
            <Plus size={14} /> Добавить
          </button>
        </div>
      </div>
    </>
  );
}

function ExportSettings() {
  const s = useStore(st => st.settings);
  const info = useStore(st => st.info);
  return (
    <>
      <div className="field"><label>Чем считать видео по умолчанию</label>
        <Segmented value={s.encoder} onChange={v => saveSettings({ encoder: v })} options={[
          { value: 'auto', label: 'Авто', tip: 'Видеокарта, если есть' }, { value: 'cpu', label: 'Процессор' },
          ...(info?.encoders.includes('nvenc') ? [{ value: 'nvenc' as const, label: 'NVIDIA' }] : []),
          ...(info?.encoders.includes('qsv') ? [{ value: 'qsv' as const, label: 'Intel' }] : []),
          ...(info?.encoders.includes('amf') ? [{ value: 'amf' as const, label: 'AMD' }] : []),
        ]} />
        <div className="small-text muted">{info?.encoders.length ? `Найдено ускорение: ${info.encoders.join(', ')}` : 'Ускорение видеокартой не найдено — будет работать процессор.'}</div>
      </div>
      <div className="field"><label>Папка для готовых видео</label>
        <div className="row">
          <input className="input" readOnly value={s.exportDir || info?.videosDir || ''} />
          <button className="btn" onClick={async () => { const d = await api.folderDialog(); if (d) saveSettings({ exportDir: d }); }}>Выбрать</button>
        </div>
      </div>
      <div className="card">
        <div className="row"><Cpu size={16} /><b>FFmpeg</b><span className={'dot' + (info?.ffmpeg.ok ? ' on' : ' bad')} /></div>
        <div className="small-text muted">{info?.ffmpeg.ok ? info.ffmpeg.version : 'Не найден. Без него не сохранить видео.'}</div>
        <div className="small-text muted">FFmpeg — бесплатный «движок» обработки видео, на нём работают YouTube, VLC и многие редакторы.</div>
      </div>
    </>
  );
}

function About() {
  const info = useStore(st => st.info);
  return (
    <>
      <div className="row" style={{ gap: 14 }}>
        <Logo size={56} />
        <div>
          <div style={{ fontFamily: 'var(--display)', fontSize: 24, fontWeight: 700 }}>Кадр</div>
          <div className="muted">версия {info?.version} · {info?.platform === 'win32' ? 'Windows' : info?.platform}</div>
        </div>
      </div>
      <div>Простой и красивый видеоредактор с ИИ-помощником. Бесплатный, с открытым кодом.</div>
      <div className="row wrap">
        <button className="btn" onClick={() => api.openExternal('https://github.com/krasking94/kadr-editor')}><ExternalLink size={14} /> Страница проекта</button>
        <button className="btn" onClick={() => api.openExternal('https://github.com/krasking94/kadr-editor/issues/new')}>Сообщить об ошибке</button>
        <button className="btn ghost" onClick={() => info && api.openPath(info.userData)}>Папка настроек</button>
      </div>
      <div className="card small-text muted" style={{ lineHeight: 1.6 }}>
        Внутри: Electron, React, FFmpeg (лицензия LGPL/GPL, поставляется отдельной программой), шрифты Onest, Montserrat, Rubik, Unbounded, Oswald, Russo One, Comfortaa, PT Serif, Caveat, Lobster, Press Start 2P, JetBrains Mono (лицензия SIL OFL), иконки Lucide.
      </div>
    </>
  );
}
