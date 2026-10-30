// Чат с ИИ-помощником. Каждое его действие показано карточкой, а в редакторе — подсветкой и сообщением.
import { useEffect, useRef, useState } from 'react';
import { Bot, Camera, Check, ChevronDown, Plug, RotateCcw, Send, Sparkles, Square, X } from 'lucide-react';
import { PROVIDERS, providerPreset } from '../../shared/providers';
import { set, useStore } from '../state/store';
import { askAssistant, resetAssistant, stopAssistant, useAssistant, type ChatItem } from '../state/assistant';
import { saveSettings } from '../state/settings-actions';
import { openMenu } from './ui';

const QUICK = [
  'Убери паузы в речи',
  'Сделай субтитры',
  'Добавь заголовок в начало',
  'Поставь переходы между клипами',
  'Сделай цвет как в кино',
  'Сделай версию для Reels',
  'Что улучшить в ролике?',
];

export function AssistantPanel() {
  const items = useAssistant(s => s.items);
  const busy = useAssistant(s => s.busy);
  const thinking = useAssistant(s => s.thinking);
  const settings = useStore(s => s.settings);
  const secrets = useStore(s => s.secrets);
  const [text, setText] = useState('');
  const [withFrame, setWithFrame] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);
  const preset = providerPreset(settings.ai.provider);
  const model = settings.ai.providers[preset.id]?.model || preset.model;
  const ready = !preset.needsKey || !!secrets[preset.id];

  useEffect(() => { chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' }); }, [items.length, thinking]);

  const send = (t = text) => {
    if (!t.trim() || busy) return;
    askAssistant(t, withFrame && preset.vision);
    setText('');
  };

  const pickProvider = (e: React.MouseEvent) => openMenu([
    { header: 'Какая нейросеть отвечает' },
    ...PROVIDERS.map(p => ({
      label: p.label + (p.needsKey && !secrets[p.id] ? ' — нужен ключ' : ''), icon: p.id === preset.id ? <Check size={14} /> : <span />,
      onClick: () => saveSettings({ ai: { ...settings.ai, provider: p.id } }),
    })),
    { separator: true },
    { label: 'Настроить ключи и модели…', icon: <Plug size={14} />, onClick: () => set({ dialog: 'settings', settingsTab: 'ai' }) },
  ], e.clientX, e.clientY);

  return (
    <div className="assistant">
      <div className="panel-head">
        <Sparkles size={16} color="var(--accent)" /><h3>ИИ-помощник</h3>
        <button className="icon-btn small" data-tip="Новый разговор" onClick={resetAssistant}><RotateCcw size={14} /></button>
        <button className="icon-btn small" data-tip="Скрыть (Ctrl+J)" onClick={() => set({ assistantOpen: false })}><X size={14} /></button>
      </div>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)' }}>
        <button className="btn small" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={pickProvider} data-tip="Выбрать нейросеть">
          <span className={'dot' + (ready ? ' on' : ' bad')} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{preset.label}</span>
          <span className="muted mono" style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis' }}>{model}</span>
          <ChevronDown size={13} style={{ marginLeft: 'auto' }} />
        </button>
      </div>
      <div className="chat" ref={chatRef}>
        {!items.length && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="msg bot">
              Привет! Я монтирую по вашей просьбе. Напишите, что сделать, — например, «убери паузы и добавь субтитры». Все мои действия появятся на таймлайне, и любое можно отменить кнопкой <b>Ctrl+Z</b>.
            </div>
            {!ready && (
              <div className="card">
                <div className="row"><Plug size={16} color="var(--warn)" /><b>Подключите нейросеть</b></div>
                <div className="small-text muted">Для «{preset.label}» нужен ключ. Это как пароль от сервиса: его выдают на сайте нейросети. Есть и бесплатные варианты без ключа — Ollama на вашем компьютере.</div>
                <button className="btn primary small" onClick={() => set({ dialog: 'settings', settingsTab: 'ai' })}>Подключить</button>
              </div>
            )}
          </div>
        )}
        {items.map(i => <ChatRow key={i.id} item={i} />)}
        {thinking && <div className="typing"><i /><i /><i /></div>}
      </div>
      <div className="composer">
        {!items.length && <div className="quick">{QUICK.map(q => <button key={q} className="chip" onClick={() => send(q)}>{q}</button>)}</div>}
        <textarea className="input" rows={2} value={text} placeholder="Что сделать с видео?" onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <div className="row">
          <button className={'icon-btn small' + (withFrame ? ' active' : '')} disabled={!preset.vision} onClick={() => setWithFrame(!withFrame)}
            data-tip={preset.vision ? 'Показать ИИ текущий кадр вместе с сообщением' : 'Эта нейросеть не умеет смотреть картинки'} data-tip-pos="top"><Camera size={14} /></button>
          <span className="small-text muted">Enter — отправить, Shift+Enter — новая строка</span>
          <div className="spacer" />
          {busy
            ? <button className="btn small danger" onClick={stopAssistant}><Square size={12} fill="currentColor" /> Стоп</button>
            : <button className="btn small primary" disabled={!text.trim()} onClick={() => send()}><Send size={13} /> Отправить</button>}
        </div>
      </div>
    </div>
  );
}

function ChatRow({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case 'user':
      return <div className="msg user">{item.text}{item.image && <img src={item.image} style={{ display: 'block', width: 160, borderRadius: 6, marginTop: 6 }} />}</div>;
    case 'bot':
      return <div className="msg bot">{item.text}</div>;
    case 'error':
      return <div className="msg err">{item.text}</div>;
    case 'info':
      return <div className="msg info">{item.text}</div>;
    case 'tool':
      return (
        <div className={'tool-card' + (item.status === 'running' ? ' running' : item.status === 'fail' ? ' fail' : '')}>
          <div>
            <div className="row" style={{ gap: 7 }}>
              {item.status === 'running' ? <span className="spinner" /> : item.status === 'ok' ? <Check size={14} color="var(--good)" /> : <X size={14} color="var(--bad)" />}
              <Bot size={13} color="var(--accent)" />
              <span>{item.title}</span>
              {item.detail && <span className="muted">{item.detail}</span>}
            </div>
            {item.result && <div className="small-text" style={{ color: 'var(--bad)', marginTop: 4 }}>{item.result}</div>}
            {item.image && <img src={item.image} />}
          </div>
        </div>
      );
  }
}
