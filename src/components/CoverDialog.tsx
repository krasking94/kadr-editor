// Обложка для ролика (с 0.7): кадр из видео + крупный текст в один клик, как у популярных блогеров.
import { useEffect, useRef, useState } from 'react';
import { ImageDown, RefreshCw } from 'lucide-react';
import { api } from '../api';
import { defaultBrand } from '../../shared/settings';
import { formatTime } from '../../shared/timeline';
import { renderFrame } from '../state/actions';
import { set, toast, useStore } from '../state/store';
import { loadFonts } from '../lib/fonts';
import { Modal, Segmented, Slider } from './ui';
import { drawCover, type CoverLayout as Layout } from '../lib/cover';


const LAYOUTS: { value: Layout; label: string; tip: string }[] = [
  { value: 'bottom', label: 'Снизу', tip: 'Текст внизу на тёмной полосе' },
  { value: 'center', label: 'По центру', tip: 'Огромный текст с обводкой' },
  { value: 'left', label: 'Слева', tip: 'Текст слева, картинка справа' },
  { value: 'top', label: 'Сверху', tip: 'Текст сверху, лицо остаётся видно' },
];

const STYLES = [
  { id: 'yellow', label: 'Жёлтый', color: '#ffe14d', stroke: '#000000' },
  { id: 'white', label: 'Белый', color: '#ffffff', stroke: '#000000' },
  { id: 'red', label: 'Красный', color: '#ff3b47', stroke: '#ffffff' },
  { id: 'brand', label: 'Бренд', color: '', stroke: '#000000' },
];

export function CoverDialog() {
  const project = useStore(s => s.project)!;
  const playhead = useStore(s => s.playhead);
  const rawBrand = useStore(s => s.settings.brand);
  const brand = { ...defaultBrand(), ...rawBrand };
  const tall = project.height > project.width;
  const W = tall ? 1080 : 1280, H = tall ? 1920 : 720;
  const [title, setTitle] = useState(project.name === 'Новый проект' ? 'Как я это сделал' : project.name);
  const [sub, setSub] = useState('');
  const [layout, setLayout] = useState<Layout>('bottom');
  const [style, setStyle] = useState('yellow');
  const [pop, setPop] = useState(0.5);
  const [zoom, setZoom] = useState(1);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [at, setAt] = useState(playhead);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLCanvasElement>(null);

  const grab = async (t: number) => {
    setBusy(true);
    try {
      const b64 = await renderFrame(t, W);
      const im = new Image();
      im.src = 'data:image/jpeg;base64,' + b64;
      await im.decode();
      setImg(im);
      setAt(t);
    } catch (e) {
      toast('error', 'Не удалось взять кадр', { detail: String(e) });
    }
    setBusy(false);
  };
  useEffect(() => { loadFonts(); grab(playhead); }, []);

  const st = STYLES.find(s => s.id === style)!;
  const opts = { title, sub, layout, color: st.color || brand.primary, stroke: st.stroke, accent: brand.accent, font: brand.font, pop, zoom };
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    cv.width = W; cv.height = H;
    drawCover(cv.getContext('2d')!, img, W, H, opts);
  }, [img, JSON.stringify(opts), W, H]);

  const save = async () => {
    const path = await api.saveTextDialog(`${project.name} — обложка`, 'png', 'Сохранить обложку');
    if (!path) return;
    await api.saveImageAs(ref.current!.toDataURL('image/png'), path);
    toast('success', 'Обложка сохранена', { detail: path, action: { label: 'Показать', run: () => api.showItem(path) } });
    set({ dialog: null });
  };

  return (
    <Modal title="Обложка для ролика" icon={<ImageDown size={18} />} width={tall ? 760 : 980} onClose={() => set({ dialog: null })}
      footer={<><span className="small-text muted" style={{ marginRight: 'auto' }}>{W}×{H} — {tall ? 'для Reels, Shorts и TikTok' : 'как просит YouTube'}</span>
        <button className="btn ghost" onClick={() => set({ dialog: null })}>Отмена</button>
        <button className="btn primary" onClick={save} disabled={!img}><ImageDown size={14} /> Сохранить обложку</button></>}>
      <div className="cover-layout" style={{ gridTemplateColumns: tall ? '260px 1fr' : '1fr 300px' }}>
        <div className="cover-canvas" style={{ order: tall ? 2 : 1 }}>
          <canvas ref={ref} style={{ width: '100%', aspectRatio: `${W} / ${H}`, maxHeight: tall ? 560 : undefined, objectFit: 'contain' }} />
        </div>
        <div className="cover-side" style={{ order: tall ? 1 : 2 }}>
          <div className="field"><label>Заголовок</label><textarea className="input" rows={2} value={title} onChange={e => setTitle(e.target.value)} placeholder="Коротко и громко: 3–5 слов" /></div>
          <div className="field"><label>Плашка (можно пусто)</label><input className="input" value={sub} onChange={e => setSub(e.target.value)} placeholder="например: ЗА 5 МИНУТ" /></div>
          <div className="field"><label>Где текст</label><Segmented value={layout} onChange={setLayout} options={LAYOUTS} /></div>
          <div className="field"><label>Цвет текста</label><Segmented value={style} onChange={setStyle} options={STYLES.map(s => ({ value: s.id, label: s.label }))} /></div>
          <Slider label="Сочность картинки" value={pop} min={0} max={1} step={0.05} def={0.5} format={v => Math.round(v * 100) + '%'} onChange={setPop} hint="Яркие обложки чаще замечают в ленте" />
          <Slider label="Приблизить кадр" value={zoom} min={1} max={2} step={0.05} def={1} format={v => Math.round(v * 100) + '%'} onChange={setZoom} />
          <div className="row wrap">
            <button className="btn small" disabled={busy} onClick={() => grab(useStoreTime())}><RefreshCw size={13} className={busy ? 'spin' : ''} /> Кадр под курсором</button>
            <span className="small-text muted">сейчас: {formatTime(at)}</span>
          </div>
          <div className="small-text muted">Совет: передвиньте линию времени на кадр с ярким выражением лица и нажмите «Кадр под курсором».</div>
        </div>
      </div>
    </Modal>
  );
}

const useStoreTime = () => useStore.getState().playhead;
