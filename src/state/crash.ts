// Отчёты об ошибках в окне программы (с 0.9): ловим ошибки интерфейса, а при следующем запуске
// показываем, что случилось, и предлагаем отправить отчёт или скопировать его.
import { create } from 'zustand';
import { api } from '../api';
import { get, toast } from './store';

export interface CrashReport { id: string; at: number; version: string; os: string; kind: string; message: string; stack?: string; sent?: boolean }

interface CrashState { reports: CrashReport[]; unclean: boolean; dir: string; loaded: boolean; dismissed: boolean }
export const useCrash = create<CrashState>(() => ({ reports: [], unclean: false, dir: '', loaded: false, dismissed: false }));

let hooked = false;
/** Ошибки окна программы пишем в отчёт (кроме безобидных и повторов) */
export function installErrorHooks() {
  if (hooked) return;
  hooked = true;
  const harmless = /ResizeObserver loop|AbortError|Отменено|The play\(\) request was interrupted|NotAllowedError/;
  window.addEventListener('error', e => {
    const msg = e.message || String(e.error);
    if (!harmless.test(msg)) api.crashReport(msg, (e.error as Error)?.stack || `${e.filename}:${e.lineno}`);
  });
  window.addEventListener('unhandledrejection', e => {
    const err = e.reason as Error;
    const msg = err?.message || String(e.reason);
    if (!harmless.test(msg) && !/Error invoking remote method/.test(msg)) api.crashReport(msg, err?.stack);
  });
}

export async function loadReports() {
  const r = await api.crashList();
  useCrash.setState({ reports: r.reports, unclean: r.unclean, dir: r.dir, loaded: true });
}

/** Новые отчёты с прошлого запуска, которые ещё не отправляли */
export const freshReports = (s: CrashState) => s.reports.filter(r => !r.sent && r.version === (get().info?.version || r.version) && Date.now() - r.at < 7 * 864e5);

export async function copyReports(ids: string[]) {
  const texts: string[] = [];
  for (const id of ids) texts.push(await api.crashText(id));
  await navigator.clipboard.writeText(texts.join('\n\n────────\n\n'));
  toast('success', 'Отчёт скопирован', { detail: 'Вставьте его в письмо или сообщение разработчику (Ctrl+V).' });
}

export async function sendReports(ids: string[]) {
  try {
    const n = await api.crashSend(ids);
    toast('success', `Отчёт отправлен (${n})`, { detail: 'Спасибо! Это помогает сделать программу надёжнее.' });
    await loadReports();
  } catch (e) {
    toast('error', 'Не удалось отправить', { detail: String((e as Error).message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') });
  }
}

export async function clearReports() {
  await api.crashClear();
  await loadReports();
}

/** Отчёты отправляются сами, если в настройках указан адрес и включено «отправлять автоматически» */
export async function autoSendReports() {
  const s = get().settings.reports;
  if (!s?.auto || !s.url) return;
  const fresh = freshReports(useCrash.getState());
  if (fresh.length) await api.crashSend(fresh.map(r => r.id)).catch(() => undefined);
}
