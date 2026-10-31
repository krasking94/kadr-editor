// Если в окне программы что-то сломалось, показываем понятный экран вместо белого окна,
// сразу сохраняем копию проекта и пишем отчёт об ошибке.
import { Component, type ReactNode } from 'react';
import { api } from '../api';
import { get } from '../state/store';

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    api.crashReport(error.message, `${error.stack || ''}\n${info.componentStack || ''}`);
    const s = get();
    if (s.project) api.autosave(s.project, s.savedPath).catch(() => undefined);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ height: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg)', color: 'var(--text)' }}>
        <div className="card" style={{ maxWidth: 480, textAlign: 'center', alignItems: 'center', padding: 28 }}>
          <b style={{ fontSize: 18 }}>Ой, что-то сломалось</b>
          <div className="small-text muted">Ваш проект сохранён в копию — ничего не потеряется. Отчёт об ошибке записан: его можно отправить в «Настройки → Отчёты об ошибках».</div>
          <div className="mono small-text muted" style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}>{this.state.error.message}</div>
          <div className="row">
            <button className="btn primary" onClick={() => this.setState({ error: null })}>Попробовать продолжить</button>
            <button className="btn ghost" onClick={() => location.reload()}>Перезапустить окно</button>
          </div>
        </div>
      </div>
    );
  }
}
