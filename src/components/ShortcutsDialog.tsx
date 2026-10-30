import { Keyboard } from 'lucide-react';
import { COMMANDS, prettyKeys } from '../lib/commands';
import { set } from '../state/store';
import { Kbd, Modal } from './ui';

export function ShortcutsList() {
  const groups = [...new Set(COMMANDS.filter(c => c.keys).map(c => c.group))];
  return (
    <div style={{ columns: 2, columnGap: 28 }}>
      {groups.map(g => (
        <div key={g} style={{ breakInside: 'avoid', marginBottom: 16 }}>
          <div className="section-title">{g}</div>
          {COMMANDS.filter(c => c.group === g && c.keys).map(c => (
            <div key={c.id} className="row" style={{ justifyContent: 'space-between', padding: '4px 0', fontSize: 12.5 }}>
              <span style={{ color: 'var(--text-2)' }}>{c.label}</span>
              <span className="row" style={{ gap: 4 }}>{c.keys!.slice(0, 2).map(k => <Kbd key={k}>{prettyKeys(k)}</Kbd>)}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function ShortcutsDialog() {
  return (
    <Modal title="Горячие клавиши" icon={<Keyboard size={18} />} width={820} onClose={() => set({ dialog: null })}>
      <div className="tip-card">Клавиши работают в любой раскладке: русской и английской. Все команды с поиском — <Kbd>Ctrl + K</Kbd>.</div>
      <ShortcutsList />
    </Modal>
  );
}
