// Телесуфлёр (с 0.9): текст крупно плывёт по экрану, а камера пишет, как вы его читаете.
// Камера стоит рядом с текстом, поэтому взгляд остаётся почти в объектив. Запись сразу встаёт в ролик.
import { useEffect, useRef, useState } from 'react';
import { Camera, FlipHorizontal2, Pause, Play, Sparkles, Square, X } from 'lucide-react';
import { api } from '../api';
import { defaultPrompter } from '../../shared/settings';
import { formatTime } from '../../shared/timeline';
import { get, set, toast, useStore } from '../state/store';
import * as A from '../state/actions';
import { saveSettings } from '../state/settings-actions';
import { aiReady } from '../state/script';
import { Slider } from './ui';

const SCRIPT_SYSTEM = `You write short spoken scripts for a blogger to read on camera from a teleprompter.
Write in the user's language (usually Russian). Plain text only, no headings, no stage directions, no emoji.
Short sentences, one thought per paragraph, conversational tone, strong first sentence. 120-220 words unless asked otherwise.`;

export function Prompter() {
  const saved = { ...defaultPrompter(), ...useStore(s => s.settings.prompter) };
  const [text, setText] = useState(saved.text);
  const [speed, setSpeed] = useState(saved.speed);
  const [size, setSize] = useState(saved.size);
  const [mirror, setMirror] = useState(saved.mirror);
  const [editing, setEditing] = useState(!saved.text.trim());
  const [scrolling, setScrolling] = useState(false);
  const [state, setState] = useState<'off' | 'ready' | 'rec' | 'saving'>('off');
  const [elapsed, setElapsed] = useState(0);
  const [thinking, setThinking] = useState(false);
  const [topic, setTopic] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const offset = useRef(0);
  const started = useRef(0);

  // настройки запоминаем, чтобы в следующий раз всё было как было
  useEffect(() => {
    const t = setTimeout(() => saveSettings({ prompter: { text, speed, size, mirror } }), 600);
    return () => clearTimeout(t);
  }, [text, speed, size, mirror]);

  const camOn = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: { width: 1920, height: 1080 } });
      stream.current = s;
      if (videoRef.current) { videoRef.current.srcObject = s; videoRef.current.play().catch(() => undefined); }
      setState('ready');
    } catch {
      toast('error', 'Нет доступа к камере', { detail: 'Проверьте, что камера подключена и не занята другой программой (Zoom, Telegram).' });
    }
  };
  const release = () => { stream.current?.getTracks().forEach(t => t.stop()); stream.current = null; };
  useEffect(() => { if (!editing) camOn(); return () => { if (rec.current?.state === 'recording') rec.current.stop(); release(); }; }, [editing]);

  // плавная прокрутка: скорость 1 — примерно 2,5 слова в секунду при обычном размере
  useEffect(() => {
    let raf = 0, last = performance.now();
    const loop = (now: number) => {
      const dt = (now - last) / 1000; last = now;
      if (scrolling && textRef.current && box.current) {
        offset.current += dt * speed * size * 0.75;
        const max = textRef.current.scrollHeight - box.current.clientHeight * 0.3;
        if (offset.current >= max) { offset.current = max; setScrolling(false); }
      }
      if (textRef.current) textRef.current.style.transform = `translateY(${box.current ? box.current.clientHeight * 0.33 - offset.current : 0}px)${mirror ? ' scaleX(-1)' : ''}`;
      if (started.current) setElapsed((now - started.current) / 1000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [scrolling, speed, size, mirror]);

  const startRec = () => {
    if (!stream.current) return;
    chunks.current = [];
    const mime = 'video/webm;codecs=vp9,opus';
    const r = new MediaRecorder(stream.current, MediaRecorder.isTypeSupported(mime) ? { mimeType: mime } : undefined);
    r.ondataavailable = e => { if (e.data.size) chunks.current.push(e.data); };
    r.onstop = async () => {
      setState('saving');
      started.current = 0;
      try {
        const blob = new Blob(chunks.current, { type: r.mimeType });
        const path = await api.saveRecording(await blob.arrayBuffer(), 'webm');
        const [m] = await A.importFiles([path]);
        if (m) {
          A.addToTimeline(m.id, 'main');
          toast('success', 'Запись с телесуфлёра добавлена в ролик', { detail: 'Оговорки и паузы легко убрать в «Монтаже по тексту».' });
        }
      } catch (e) {
        toast('error', 'Не удалось сохранить запись', { detail: String(e) });
      }
      setState('ready');
      setElapsed(0);
    };
    r.start(500);
    rec.current = r;
    // текст начинает плыть через секунду, чтобы успеть вдохнуть
    offset.current = 0;
    started.current = performance.now();
    setState('rec');
    setTimeout(() => setScrolling(true), 1000);
  };
  const stopRec = () => { setScrolling(false); rec.current?.stop(); };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (editing) { if (e.key === 'Escape') { e.stopPropagation(); set({ prompter: false }); } return; }
      e.stopPropagation();
      if (e.code === 'Space') { e.preventDefault(); setScrolling(v => !v); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); offset.current = Math.max(0, offset.current - size * 1.4); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); offset.current += size * 1.4; }
      else if (e.key === 'ArrowRight' || e.key === '+' || e.key === '=') setSpeed(v => Math.min(3, Math.round((v + 0.1) * 10) / 10));
      else if (e.key === 'ArrowLeft' || e.key === '-') setSpeed(v => Math.max(0.3, Math.round((v - 0.1) * 10) / 10));
      else if (e.key === 'Escape') { if (state === 'rec') stopRec(); else set({ prompter: false }); }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [editing, state, size]);

  const write = async () => {
    if (!topic.trim()) { toast('info', 'Напишите, о чём будет ролик'); return; }
    setThinking(true);
    try {
      const r: string = await api.aiComplete(SCRIPT_SYSTEM, topic);
      setText(r.trim());
    } catch (e) {
      toast('error', 'Нейросеть не ответила', { detail: String((e as Error).message || e) });
    }
    setThinking(false);
  };

  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (editing) {
    return (
      <div className="prompter">
        <div style={{ maxWidth: 820, width: '100%', margin: '0 auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0 }}>
          <div className="row"><Camera size={18} /><b style={{ fontSize: 18 }}>Телесуфлёр</b><span className="spacer" />
            <button className="icon-btn" onClick={() => set({ prompter: false })} data-tip="Закрыть (Esc)"><X size={16} /></button></div>
          <div className="small-text" style={{ opacity: .7 }}>Вставьте текст, который будете читать. Он поплывёт крупно по экрану рядом с камерой, а запись сразу встанет в ролик. Пробел — пауза, стрелки — быстрее, медленнее и назад.</div>
          {aiReady() && (
            <div className="row">
              <input className="input" style={{ flex: 1 }} value={topic} onChange={e => setTopic(e.target.value)} placeholder="Или напишите тему — нейросеть набросает текст: «почему я перешёл на электросамокат»" onKeyDown={e => e.key === 'Enter' && write()} />
              <button className="btn" disabled={thinking} onClick={write}><Sparkles size={14} /> {thinking ? 'Пишу…' : 'Написать текст'}</button>
            </div>
          )}
          <textarea className="input" style={{ flex: 1, fontSize: 16, lineHeight: 1.5, resize: 'none' }} value={text} onChange={e => setText(e.target.value)} placeholder="Текст для чтения…" autoFocus />
          <div className="row"><span className="small-text" style={{ opacity: .7 }}>{words} слов · примерно {formatTime((words / 2.5))} чтения</span><span className="spacer" />
            <button className="btn primary" disabled={!text.trim()} onClick={() => setEditing(false)}><Camera size={14} /> Включить камеру</button></div>
        </div>
      </div>
    );
  }
  return (
    <div className="prompter">
      <div className="prompter-text" ref={box} onWheel={e => { offset.current = Math.max(0, offset.current + e.deltaY); }}>
        <div className="prompter-line" />
        <div ref={textRef} style={{ fontSize: size }}>{text}</div>
      </div>
      <div className="prompter-cam"><video ref={videoRef} muted playsInline /></div>
      <div className="prompter-bar">
        {state === 'rec' ? <><span className="rec-dot" /><span className="mono">{formatTime(elapsed)}</span>
          <button className="btn danger" onClick={stopRec}><Square size={14} fill="currentColor" /> Остановить</button></>
          : <button className="btn primary" disabled={state !== 'ready'} onClick={startRec}><span style={{ width: 11, height: 11, borderRadius: '50%', background: '#fff' }} /> {state === 'saving' ? 'Сохраняю…' : 'Начать запись'}</button>}
        <button className="btn ghost" onClick={() => setScrolling(v => !v)}>{scrolling ? <Pause size={14} /> : <Play size={14} />} {scrolling ? 'Пауза' : 'Плыть'} (пробел)</button>
        <button className="btn ghost" onClick={() => { offset.current = 0; }}>В начало</button>
        <Slider label="Скорость" value={speed} min={0.3} max={3} step={0.1} def={1} format={v => '×' + v.toFixed(1)} onChange={setSpeed} />
        <Slider label="Размер" value={size} min={28} max={120} step={2} def={56} onChange={setSize} />
        <button className={'icon-btn' + (mirror ? ' active' : '')} data-tip="Зеркально — для стеклянного суфлёра перед камерой" onClick={() => setMirror(v => !v)}><FlipHorizontal2 size={16} /></button>
        <span className="spacer" />
        <button className="btn ghost" disabled={state === 'rec'} onClick={() => { release(); setState('off'); setEditing(true); }}>Править текст</button>
        <button className="btn ghost" disabled={state === 'rec'} onClick={() => set({ prompter: false })}><X size={14} /> Закрыть</button>
      </div>
    </div>
  );
}

export const openPrompter = () => { if (get().project) set({ prompter: true, playing: false }); };
