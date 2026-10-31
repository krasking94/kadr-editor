// Короткое обучение при первом запуске: подсвечивает части окна по очереди и объясняет простыми словами.
import { useEffect, useLayoutEffect, useState } from 'react';
import { create } from 'zustand';
import { Sparkles } from 'lucide-react';
import { saveSettings } from '../state/settings-actions';

interface Step { sel: string; title: string; text: string }

const STEPS: Step[] = [
  { sel: '.side-panel', title: 'Ваши файлы', text: 'Перетащите сюда видео, фото и музыку из папки — или нажмите «Добавить файлы». Слева — вкладки: текст и титры, стикеры, переходы, запись экрана и создание нейросетью.' },
  { sel: '.preview', title: 'Окно просмотра', text: 'Здесь виден ролик таким, каким он сохранится. Картинки и надписи можно двигать прямо мышкой. Пробел — смотреть и ставить на паузу.' },
  { sel: '.timeline', title: 'Таймлайн', text: 'Клипы идут по порядку слева направо. S — разрезать под линией, Delete — удалить, Ctrl+Z — отменить любой шаг.' },
  { sel: '.inspector', title: 'Настройки клипа', text: 'Щёлкните по клипу — здесь появятся его цвет, эффекты, движение и звук. Ничего не выбрано — настройки всего проекта и громкость дорожек.' },
  { sel: '.assistant', title: 'ИИ-помощник', text: 'Напишите обычными словами, что сделать: «убери паузы, сделай субтитры как у блогеров и подложи спокойную музыку». Помощник смонтирует сам, а вы увидите каждый шаг.' },
  { sel: '.titlebar .btn.primary', title: 'Сохранить видео', text: 'Когда всё готово — нажмите сюда. Можно сразу сохранить несколько форматов: для YouTube, Reels и квадрат.' },
];

const useTour = create<{ step: number | null }>(() => ({ step: null }));

export function startTour() {
  useTour.setState({ step: 0 });
}

function finish() {
  useTour.setState({ step: null });
  saveSettings({ tourDone: true });
}

export function Tour() {
  const step = useTour(s => s.step);
  const [rect, setRect] = useState<DOMRect | null>(null);
  // шаги, у которых сейчас нет места на экране (панель закрыта), пропускаем
  const shown = STEPS.map((s, i) => ({ ...s, i })).filter(s => document.querySelector(s.sel));
  const cur = step === null ? null : shown.find(s => s.i >= step) ?? null;
  useLayoutEffect(() => {
    if (!cur) { setRect(null); return; }
    const measure = () => setRect(document.querySelector(cur.sel)?.getBoundingClientRect() ?? null);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [cur?.i]);
  useEffect(() => {
    if (step === null) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish();
      if (e.key === 'Enter' || e.key === 'ArrowRight') next();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });
  if (step === null) return null;
  if (!cur || !rect) {
    if (step !== null && !cur) queueMicrotask(finish);
    return null;
  }
  const pos = shown.indexOf(cur);
  const last = pos === shown.length - 1;
  function next() {
    if (!cur) return;
    const n = shown[shown.indexOf(cur) + 1];
    if (n) useTour.setState({ step: n.i }); else finish();
  }
  // карточка рядом с подсвеченной частью: справа, слева, снизу или сверху — где больше места
  const W = 320, vw = window.innerWidth, vh = window.innerHeight;
  let left = rect.right + 16, top = rect.top + 20;
  if (left + W > vw - 12) left = rect.left - W - 16;
  if (left < 12) { left = Math.min(vw - W - 12, Math.max(12, rect.left + rect.width / 2 - W / 2)); top = rect.bottom + 16 > vh - 200 ? rect.top - 210 : rect.bottom + 16; }
  top = Math.max(12, Math.min(vh - 220, top));
  return (
    <div className="tour" onPointerDown={e => e.stopPropagation()}>
      <div className="tour-hole" style={{ left: rect.left - 4, top: rect.top - 4, width: rect.width + 8, height: rect.height + 8 }} />
      <div className="tour-card" style={{ left, top, width: W }}>
        <div className="row" style={{ gap: 8 }}><Sparkles size={16} color="var(--accent)" /><b>{cur.title}</b><span className="spacer" /><span className="small-text muted">{pos + 1} из {shown.length}</span></div>
        <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--text-2)' }}>{cur.text}</div>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <button className="btn small ghost" onClick={finish}>Пропустить</button>
          <button className="btn small primary" onClick={next}>{last ? 'Начать монтаж' : 'Дальше'}</button>
        </div>
      </div>
    </div>
  );
}
