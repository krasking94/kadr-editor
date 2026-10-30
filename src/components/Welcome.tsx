// Стартовый экран: выбрать формат нового ролика, открыть недавний проект или пример.
import { useEffect, useState } from 'react';
import { Captions, Clapperboard, FolderOpen, History, Keyboard, Layers, Plug, Settings, Sparkles, Undo2, Wand2, X, ScrollText, Smartphone, AppWindow, Diamond, Mic2, ScanFace } from 'lucide-react';
import { api } from '../api';
import { FORMAT_PRESETS } from '../../shared/timeline';
import { set, toast, useStore } from '../state/store';
import { loadProject, openNewProject, openProjectFile, openSampleProject } from '../state/actions';
import { loadSettings } from '../state/settings-actions';
import { Logo } from './Logo';

interface Autosave { id: string; name: string; savedAt: number; savedPath: string | null; file: string }

const FEATURES = [
  { icon: Sparkles, title: 'ИИ-помощник', text: 'Пишете «убери паузы и сделай субтитры» — и видите, как он монтирует.' },
  { icon: Plug, title: 'Любая нейросеть', text: 'Claude, ChatGPT, Gemini, DeepSeek, YandexGPT, локальные модели. Плюс MCP для внешних ИИ.' },
  { icon: Undo2, title: 'Ничего не страшно', text: 'Любой шаг отменяется. История шагов показывает, кто и что изменил.' },
  { icon: ScrollText, title: 'Монтаж через текст', text: 'Удалили фразу в тексте — она вырезана из видео. Паузы и «эээ» убираются одной кнопкой.' },
  { icon: Smartphone, title: 'Shorts из длинного видео', text: 'ИИ находит лучшие моменты и делает вертикальные ролики с субтитрами и лицом в центре.' },
  { icon: AppWindow, title: 'Окна как вам удобно', text: 'Любую панель можно оторвать, поставить где угодно или пристыковать к краю.' },
  { icon: Diamond, title: 'Ключевые кадры и фон', text: 'Плавное движение по ключам и удаление фона без зелёного экрана — прямо на компьютере.' },
  { icon: Captions, title: 'Субтитры из речи', text: 'Распознавание речи и красивые подписи в один клик.' },
  { icon: Wand2, title: 'Цвет и эффекты', text: '10 готовых стилей, яркость, контраст, виньетка, плёнка, плавное приближение.' },
  { icon: Mic2, title: 'Голос как в студии', text: 'Шумоподавление и ровная громкость одной кнопкой, музыка тише под речь.' },
  { icon: ScanFace, title: 'Вертикаль с лицом', text: 'Видео 16:9 становится 9:16, а «камера» сама держит человека в кадре.' },
  { icon: Layers, title: 'Слои и переходы', text: 'Картинка в картинке, 19 переходов, текст с анимацией, музыка с приглушением под голос.' },
];

function ago(t: number) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'только что';
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч назад`;
  return new Date(t).toLocaleDateString('ru');
}

export function Welcome() {
  const recent = useStore(s => s.settings.recent);
  const info = useStore(s => s.info);
  const [autosaves, setAutosaves] = useState<Autosave[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.autosaves().then(setAutosaves).catch(() => undefined); loadSettings(); }, []);

  const restore = async (a: Autosave) => {
    try {
      const d = await api.readAutosave(a.file);
      for (const m of d.project.media) m.missing = !(await api.exists(m.path));
      await loadProject(d.project, d.savedPath, true);
      toast('success', `Работа «${a.name}» восстановлена`, { detail: 'Не забудьте сохранить проект (Ctrl+S).' });
    } catch (e) {
      toast('error', 'Не удалось восстановить', { detail: String(e) });
    }
  };

  return (
    <div className="welcome">
      <div className="welcome-bg">
        <div className="blob" style={{ width: 520, height: 520, left: -120, top: -160, background: 'var(--accent)' }} />
        <div className="blob" style={{ width: 460, height: 460, right: -100, top: 120, background: 'var(--accent-2)', animationDelay: '-6s' }} />
        <div className="blob" style={{ width: 380, height: 380, left: '35%', bottom: -220, background: '#2bd4c5', opacity: 0.25, animationDelay: '-11s' }} />
      </div>
      <div className="titlebar" style={{ background: 'transparent', borderBottom: 0, position: 'relative' }}>
        <div className="drag" />
        <button className="icon-btn" data-tip="Горячие клавиши" onClick={() => set({ dialog: 'shortcuts' })}><Keyboard size={16} /></button>
        <button className="icon-btn" data-tip="Настройки" onClick={() => set({ dialog: 'settings', settingsTab: 'general' })}><Settings size={16} /></button>
      </div>
      <div className="welcome-inner" style={{ paddingTop: 20 }}>
        <div className="hero">
          <div className="row" style={{ gap: 12, marginBottom: 22 }}>
            <Logo size={40} />
            <span style={{ fontFamily: 'var(--display)', fontWeight: 700, fontSize: 22 }}>Хлопушка</span>
            <span className="badge">версия {info?.version || '…'}</span>
          </div>
          <h1>Монтаж, который <span className="grad">понятен с первого кадра</span></h1>
          <p>Выберите, где будет ролик, — и перетащите в окно видео, фото и музыку. Каждое действие сразу видно, а ИИ-помощник сделает скучную работу за вас.</p>
          <div className="row wrap" style={{ marginTop: 22, gap: 10 }}>
            <button className="btn primary big" disabled={busy} onClick={async () => { setBusy(true); await openSampleProject(); setBusy(false); }}>
              <Clapperboard size={17} /> {busy ? 'Готовлю пример…' : 'Попробовать на примере'}
            </button>
            <button className="btn big" onClick={() => openProjectFile()}><FolderOpen size={17} /> Открыть проект</button>
          </div>
        </div>

        {info && !info.ffmpeg.ok && (
          <div className="warning-box">
            <Settings size={18} color="var(--warn)" />
            <div><b>Не найден FFmpeg.</b> Это бесплатный «движок», который сохраняет видео. В установщике «Хлопушки» он уже есть — попробуйте переустановить программу.</div>
          </div>
        )}

        {autosaves.length > 0 && (
          <div>
            <div className="section-title"><History size={14} /> Восстановить несохранённую работу</div>
            <div className="recent-list">
              {autosaves.slice(0, 3).map(a => (
                <div key={a.id} className="recent" onClick={() => restore(a)} style={{ borderColor: 'color-mix(in srgb, var(--warn) 45%, transparent)' }}>
                  <div className="r-icon" style={{ background: 'color-mix(in srgb, var(--warn) 18%, transparent)', color: 'var(--warn)' }}><History size={18} /></div>
                  <div className="r-text"><b>{a.name}</b><small>автосохранение · {ago(a.savedAt)}</small></div>
                  <button className="icon-btn small" data-tip="Удалить копию" onClick={async e => { e.stopPropagation(); await api.dropAutosave(a.id); setAutosaves(x => x.filter(y => y.id !== a.id)); }}><X size={13} /></button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <div className="section-title">Новый проект — выберите формат</div>
          <div className="format-cards">
            {FORMAT_PRESETS.map(f => {
              const k = 46 / Math.max(f.width, f.height);
              return (
                <button key={f.id} className="format-card" onClick={() => openNewProject(f.width, f.height)}>
                  <div className="frame"><div style={{ width: f.width * k * 1.3, height: f.height * k * 1.3 }} /></div>
                  <div><b>{f.label}</b><br /><small>{f.hint}</small></div>
                </button>
              );
            })}
          </div>
        </div>

        {recent.length > 0 && (
          <div>
            <div className="section-title">Недавние проекты</div>
            <div className="recent-list">
              {recent.slice(0, 9).map(r => (
                <div key={r.path} className="recent" onClick={() => openProjectFile(r.path)} data-tip={r.path} data-tip-pos="top">
                  <div className="r-icon"><Clapperboard size={18} /></div>
                  <div className="r-text"><b>{r.name}</b><small>{ago(r.openedAt)}</small></div>
                  <button className="icon-btn small" data-tip="Убрать из списка" onClick={async e => { e.stopPropagation(); await api.removeRecent(r.path); loadSettings(); }}><X size={13} /></button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <div className="section-title">Что умеет «Хлопушка»</div>
          <div className="feature-row">
            {FEATURES.map(f => (
              <div key={f.title} className="feature">
                <div className="f-icon"><f.icon size={17} /></div>
                <div><b>{f.title}</b><span>{f.text}</span></div>
              </div>
            ))}
          </div>
        </div>
        <div className="muted small-text" style={{ textAlign: 'center' }}>
          Бесплатная программа с открытым кодом · <a style={{ color: 'inherit', cursor: 'pointer' }} onClick={() => api.openExternal('https://github.com/krasking94/kadr-editor')}>github.com/krasking94/kadr-editor</a>
        </div>
      </div>
    </div>
  );
}
