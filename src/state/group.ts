// Вложенные клипы (с 0.9): «Объединить в один клип» и «Разобрать обратно».
import { api } from '../api';
import type { MediaClip, MediaItem } from '../../shared/types';
import { findClip, uid } from '../../shared/timeline';
import { applyGroup, groupProject, planGroup, ungroup } from '../../shared/group';
import { commit, endTask, get, set, startTask, toast, updateTask } from './store';
import { loadMediaCache, projectForRender, textRenders } from './actions';

const clean = (e: unknown) => String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function canGroup(ids: string[]): string | null {
  const p = get().project;
  if (!p) return 'Нет проекта';
  const plan = planGroup(p, ids);
  return 'error' in plan ? plan.error : null;
}

/** Собрать выбранные клипы (и всё, что лежит над ними) в один клип */
export async function groupClips(ids: string[], o: { name?: string; source?: string } = {}): Promise<string> {
  const p0 = get().project!;
  const plan = planGroup(p0, ids);
  if ('error' in plan) { toast('info', plan.error); throw new Error(plan.error); }
  const part = projectForRender(groupProject(p0, plan));
  const count = plan.to - plan.from + 1 + plan.layers.reduce((s, l) => s + l.ids.length, 0);
  const name = o.name || `Вложенный клип (${count})`;
  const jobId = 'g' + Date.now();
  const task = startTask('Собираю клипы в один', () => api.exportCancel(jobId));
  const off = api.onProcessProgress((ev: { jobId: string; progress: number }) => { if (ev.jobId === jobId) updateTask(task, { progress: ev.progress }); });
  let path: string;
  try {
    path = await api.renderPart(jobId, part, await textRenders(part), `${p0.name} — ${name}`);
  } catch (e) {
    const msg = clean(e);
    if (msg !== 'Отменено') toast('error', 'Не удалось собрать клипы', { detail: msg });
    throw new Error(msg);
  } finally {
    off();
    endTask(task);
  }
  const info = await api.probe(path);
  const media: MediaItem = { id: uid('m'), ...info, name };
  let id = '';
  // проект могли поменять, пока шла сборка — проверяем, что кусок всё ещё тот же
  const again = planGroup(get().project!, ids);
  if ('error' in again || again.from !== plan.from || again.to !== plan.to) {
    toast('warn', 'Пока шла сборка, клипы поменялись', { detail: 'Попробуйте ещё раз.' });
    throw new Error('Клипы поменялись');
  }
  commit('Клипы объединены в один', pr => {
    pr.media.push(media);
    const c = applyGroup(pr, again, media.id, media.duration, name);
    id = c.id;
    return [c.id];
  }, { source: o.source });
  loadMediaCache(media);
  set({ selection: [id] });
  if (!o.source || o.source === 'user') toast('success', 'Получился один клип', { detail: 'Его можно двигать, резать, красить и ускорять целиком. «Разобрать» вернёт всё как было.' });
  return id;
}

/** Разобрать вложенный клип обратно на исходные */
export function ungroupClip(id: string, source?: string): string[] {
  const f = findClip(get().project!, id);
  if (!f || f.clip.type !== 'media' || !(f.clip as MediaClip).group) { toast('info', 'Это обычный клип — разбирать нечего'); return []; }
  let out: string[] = [];
  commit('Клип разобран', p => { out = ungroup(p, id); return out; }, { source });
  set({ selection: out });
  return out;
}
