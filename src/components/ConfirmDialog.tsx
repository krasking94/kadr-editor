import { CircleHelp, Download, TriangleAlert } from 'lucide-react';
import { useStore } from '../state/store';
import { Modal } from './ui';

export function ConfirmDialog() {
  const c = useStore(s => s.confirm);
  if (!c) return null;
  const cancel = c.buttons.find(b => b.value === 'cancel')?.value ?? c.buttons[0].value;
  const icon = c.icon === 'download' ? <Download size={18} color="var(--accent)" />
    : c.buttons.some(b => b.kind === 'danger') ? <TriangleAlert size={18} color="var(--warn)" />
      : <CircleHelp size={18} color="var(--accent)" />;
  return (
    <Modal title={c.title} icon={icon} onClose={() => c.resolve(cancel)} className="confirm"
      footer={c.buttons.map(b => (
        <button key={b.value} autoFocus={b.kind === 'primary'} className={'btn ' + (b.kind || '')} onClick={() => c.resolve(b.value)}>{b.label}</button>
      ))}>
      <div style={{ color: 'var(--text-2)', lineHeight: 1.55 }}>{c.text}</div>
    </Modal>
  );
}
