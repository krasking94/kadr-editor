// Строка состояния внизу: последнее действие, фоновые задачи с прогрессом, подключение ИИ.
import { useEffect, useState } from 'react';
import { Bot, CircleCheck, Clock, FolderOpen, ListVideo, TriangleAlert, X } from 'lucide-react';
import { api } from '../api';
import { formatTime, projectDuration } from '../../shared/timeline';
import { set, sourceLabel, useStore } from '../state/store';
import { clearFinishedQueue, removeFromQueue } from '../state/actions';

export function StatusBar() {
  const last = useStore(s => s.lastAction);
  const tasks = useStore(s => s.tasks);
  const project = useStore(s => s.project)!;
  const zoom = useStore(s => s.zoom);
  const info = useStore(s => s.info);
  const queue = useStore(s => s.exportQueue);
  const [queueOpen, setQueueOpen] = useState(false);
  const [mcp, setMcp] = useState<{ running: boolean; port: number; error?: string; lastClient?: string } | null>(null);

  useEffect(() => {
    const load = () => api.mcpStatus().then((r: any) => setMcp(r.server)).catch(() => undefined);
    load();
    const off = api.onMcpClient(load);
    const t = setInterval(load, 15000);
    return () => { off(); clearInterval(t); };
  }, []);

  return (
    <div className="statusbar">
      {last && (
        <div key={last.at} className="item last" style={{ minWidth: 0 }}>
          {last.source !== 'user' && <Bot size={12} color="var(--accent)" />}
          {last.source !== 'user' ? sourceLabel(last.source) + ': ' : ''}{last.label}
        </div>
      )}
      {tasks.map(t => (
        <div key={t.id} className="item">
          <span className="spinner" style={{ width: 11, height: 11 }} />
          {t.label}
          <div className={'progress' + (t.progress === undefined ? ' indeterminate' : '')}><div style={{ width: `${(t.progress || 0) * 100}%` }} /></div>
          {t.progress !== undefined && <span className="mono">{Math.round(t.progress * 100)}%</span>}
          {t.cancel && <button className="icon-btn small" data-tip="Отменить" data-tip-pos="top" onClick={t.cancel}><X size={12} /></button>}
        </div>
      ))}
      <div className="spacer" />
      {queue.length > 0 && (
        <div className="item" style={{ cursor: 'pointer', position: 'relative' }} onClick={() => setQueueOpen(o => !o)}>
          <ListVideo size={12} color="var(--accent)" /> Очередь: {queue.filter(q => q.state === 'done').length} из {queue.length}
          {queueOpen && (
            <div className="queue-pop" onClick={e => e.stopPropagation()}>
              <div className="row" style={{ justifyContent: 'space-between' }}><b>Очередь сохранения</b>
                <button className="btn small ghost" onClick={() => { clearFinishedQueue(); setQueueOpen(false); }}>Убрать готовые</button></div>
              {queue.map(q => (
                <div key={q.id} className="queue-row" title={q.error || q.outPath}>
                  {q.state === 'run' ? <span className="spinner" style={{ width: 11, height: 11 }} /> : q.state === 'done' ? <CircleCheck size={13} color="var(--good)" /> : q.state === 'wait' ? <Clock size={13} /> : <TriangleAlert size={13} color="var(--bad)" />}
                  <span className="q-name">{q.name}</span>
                  {q.state === 'done' && <button className="icon-btn small" data-tip="Показать в папке" onClick={() => api.showItem(q.outPath)}><FolderOpen size={12} /></button>}
                  {q.state === 'wait' && <button className="icon-btn small" data-tip="Убрать из очереди" onClick={() => removeFromQueue(q.id)}><X size={12} /></button>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {info && !info.ffmpeg.ok && <div className="item" style={{ color: 'var(--bad)' }}>FFmpeg не найден</div>}
      <div className="item">{project.width}×{project.height} · {project.fps} кадр/с</div>
      <div className="item mono">{formatTime(projectDuration(project))}</div>
      <div className="item">масштаб {Math.round(zoom)} px/с</div>
      <div className="item" style={{ cursor: 'pointer' }} onClick={() => set({ dialog: 'settings', settingsTab: 'mcp' })}
        data-tip={mcp?.running ? `Внешний ИИ может подключиться по адресу\nhttp://127.0.0.1:${mcp.port}/mcp${mcp.lastClient ? '\nПоследний: ' + mcp.lastClient : ''}` : mcp?.error || 'MCP-сервер выключен'} data-tip-pos="top">
        <span className={'dot' + (mcp?.running ? ' on' : mcp?.error ? ' bad' : '')} /> MCP {mcp?.running ? mcp.port : 'выкл'}
      </div>
    </div>
  );
}
