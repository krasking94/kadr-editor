// Всплывающие сообщения в углу: что сделано, что не получилось, что сделал ИИ.
import { Check, Info, Sparkles, TriangleAlert, X } from 'lucide-react';
import { dismissToast, useStore } from '../state/store';

const ICONS = { info: Info, success: Check, error: X, warn: TriangleAlert, ai: Sparkles };

export function Toasts() {
  const toasts = useStore(s => s.toasts);
  return (
    <div className="toasts">
      {toasts.map(t => {
        const Icon = ICONS[t.kind];
        return (
          <div key={t.id} className={'toast ' + t.kind}>
            <div className="t-icon"><Icon size={13} strokeWidth={2.6} /></div>
            <div className="grow">
              <div className="t-text">{t.text}</div>
              {t.detail && <div className="t-detail">{t.detail}</div>}
              {t.action && <button className="btn small" style={{ marginTop: 8 }} onClick={() => { t.action!.run(); dismissToast(t.id); }}>{t.action.label}</button>}
            </div>
            <button className="icon-btn small" onClick={() => dismissToast(t.id)}><X size={13} /></button>
          </div>
        );
      })}
    </div>
  );
}
