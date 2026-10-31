// Вставка из буфера обмена (Ctrl+V) и перетаскивание из браузера (с 0.7):
// скриншот, скопированные в Проводнике файлы, картинка или видео с сайта сразу попадают в ролик.
import { api } from '../api';
import type { MediaItem } from '../../shared/types';
import { mainTrack } from '../../shared/timeline';
import { addToTimeline, importFiles, pasteClips } from './actions';
import { endTask, get, startTask, toast } from './store';

export const CLIPS_MARK = 'hlopushka:clips';
const clean = (e: unknown) => String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** Файлы из буфера или перетаскивания: у файлов с диска есть путь, а картинку из браузера сохраняем сами */
async function filesToPaths(files: File[]): Promise<string[]> {
  const out: string[] = [];
  for (const f of files) {
    const path = api.pathForFile(f);
    if (path) { out.push(path); continue; }
    if (!/^(image|video|audio)\//.test(f.type)) continue;
    const ext = f.type.split('/')[1].replace('jpeg', 'jpg').replace('quicktime', 'mov').replace('mpeg', 'mp3').split(/[;+]/)[0];
    const name = f.name && /\.[a-z0-9]+$/i.test(f.name) ? f.name : `${f.type.startsWith('image') ? 'Снимок' : 'Вставка'}.${ext}`;
    out.push(await api.saveBytes(await f.arrayBuffer(), name));
  }
  return out;
}

/** Поставить вставленные файлы в ролик: в пустой проект — подряд, иначе поверх видео с места курсора */
export function placeMedia(items: MediaItem[], source = 'user') {
  const p = get().project!;
  let at = get().playhead;
  const empty = !mainTrack(p).clips.length;
  for (const m of items) {
    if (m.kind === 'audio') { addToTimeline(m.id, 'audio', { start: at, source }); continue; }
    if (empty) { addToTimeline(m.id, 'main', { source }); continue; }
    addToTimeline(m.id, 'overlay', { start: at, source, out: m.kind === 'image' ? 4 : undefined, patch: { transform: { x: 0.5, y: 0.5, scale: 0.8, rotation: 0, opacity: 1 }, transformEnd: { x: 0.5, y: 0.5, scale: 0.8, rotation: 0, opacity: 1 } } });
    at += m.kind === 'image' ? 4 : m.duration;
  }
}

async function importAndPlace(paths: string[], what: string) {
  const added = await importFiles(paths);
  if (!added.length) return false;
  placeMedia(added);
  toast('success', added.length > 1 ? `${what}: ${added.length} файла` : `${what}: «${added[0].name}»`, { detail: 'Отменить — Ctrl+Z' });
  return true;
}

async function fromUrl(url: string, what: string): Promise<boolean> {
  const task = startTask('Скачиваю файл по ссылке');
  try {
    const path = await api.downloadMedia(url);
    return await importAndPlace([path], what);
  } catch (e) {
    toast('error', 'Не получилось взять файл по ссылке', { detail: clean(e) });
    return true;
  } finally {
    endTask(task);
  }
}

const isUrl = (t: string) => /^https?:\/\/\S+$/i.test(t.trim());

/** Ctrl+V: сначала файлы и картинки из буфера, потом ссылка, иначе — скопированные клипы */
export async function smartPaste(data?: DataTransfer | null): Promise<void> {
  if (!get().project) return;
  const text = data?.getData('text/plain')?.trim() || '';
  if (text === CLIPS_MARK) { pasteClips(); return; }
  try {
    const files = data ? await filesToPaths([...data.files]) : [];
    if (files.length) { await importAndPlace(files, 'Вставлено'); return; }
    if (isUrl(text)) { await fromUrl(text, 'Вставлено по ссылке'); return; }
    const sys: { paths?: string[]; url?: string } = await api.clipboardMedia().catch(() => ({}));
    if (sys.paths?.length) { await importAndPlace(sys.paths, 'Вставлено'); return; }
    if (sys.url && !get().clipboard.length) { await fromUrl(sys.url, 'Вставлено по ссылке'); return; }
  } catch (e) {
    toast('error', 'Не получилось вставить', { detail: clean(e) });
    return;
  }
  if (get().clipboard.length) pasteClips();
  else toast('info', 'В буфере обмена нет файлов', { detail: 'Скопируйте картинку, скриншот или файл в Проводнике — и нажмите Ctrl+V.' });
}

/** Перетаскивание из браузера: картинка или видео со страницы, ссылка на файл */
export async function dropFromBrowser(dt: DataTransfer): Promise<boolean> {
  const files = await filesToPaths([...dt.files]).catch(() => [] as string[]);
  if (files.length) return importAndPlace(files, 'Добавлено');
  let url = dt.getData('text/uri-list').split(/\r?\n/).find(l => l && !l.startsWith('#')) || '';
  const html = dt.getData('text/html');
  const src = /<(?:img|video|source)[^>]+src="([^"]+)"/i.exec(html)?.[1];
  if (src && /^https?:/i.test(src)) url = src.replace(/&amp;/g, '&');
  if (!url || !isUrl(url)) return false;
  return fromUrl(url, 'Добавлено из браузера');
}
