// Отчёты об ошибках (с 0.9). Если программа упала или зависла, при следующем запуске она скажет об этом
// и предложит отправить отчёт. В отчёте нет видео и личных файлов: только версия, система и текст ошибки.
import { app } from 'electron';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { arch, release, totalmem, cpus } from 'node:os';

export interface CrashReport {
  id: string;
  at: number;
  version: string;
  os: string;
  kind: 'main' | 'window' | 'gpu' | 'hang' | 'unclean' | 'ui';
  message: string;
  stack?: string;
  log: string[]; // последние строки журнала
  sent?: boolean;
}

const dir = () => { const d = join(app.getPath('userData'), 'Отчёты'); mkdirSync(d, { recursive: true }); return d; };
const runFlag = () => join(app.getPath('userData'), 'running.flag');
const logFile = () => join(dir(), 'журнал.log');

const recent: string[] = [];

/** Записать строку в журнал (последние 200 строк попадут в отчёт) */
export function log(line: string) {
  const s = `${new Date().toISOString()} ${line}`.slice(0, 600);
  recent.push(s);
  if (recent.length > 200) recent.shift();
  try {
    appendFileSync(logFile(), s + '\n');
    if (statSync(logFile()).size > 2e6) writeFileSync(logFile(), recent.join('\n') + '\n');
  } catch { /* журнал не обязателен */ }
}

const sysInfo = () => `${process.platform} ${release()} ${arch()} · ${cpus()[0]?.model?.trim() || 'CPU'} ×${cpus().length} · ${Math.round(totalmem() / 2 ** 30)} ГБ`;

/** Сохранить отчёт. Одинаковые ошибки подряд не дублируются. */
export function saveReport(kind: CrashReport['kind'], message: string, stack?: string): CrashReport | null {
  try {
    const last = listReports()[0];
    if (last && last.message === message && Date.now() - last.at < 60_000) return null;
    const r: CrashReport = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: Date.now(), version: app.getVersion(), os: sysInfo(),
      kind, message: String(message).slice(0, 2000), stack: stack ? String(stack).slice(0, 8000) : undefined, log: recent.slice(-60),
    };
    writeFileSync(join(dir(), r.id + '.json'), JSON.stringify(r, null, 2));
    // храним не больше 30 отчётов
    const all = readdirSync(dir()).filter(f => f.endsWith('.json')).sort();
    for (const f of all.slice(0, Math.max(0, all.length - 30))) rmSync(join(dir(), f), { force: true });
    log(`ОШИБКА [${kind}] ${message}`);
    return r;
  } catch { return null; }
}

export function listReports(): CrashReport[] {
  try {
    return readdirSync(dir()).filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(readFileSync(join(dir(), f), 'utf8')) as CrashReport; } catch { return null; } })
      .filter((r): r is CrashReport => !!r)
      .sort((a, b) => b.at - a.at);
  } catch { return []; }
}

export function markSent(ids: string[]) {
  for (const id of ids) {
    const f = join(dir(), id + '.json');
    try { const r = JSON.parse(readFileSync(f, 'utf8')); r.sent = true; writeFileSync(f, JSON.stringify(r, null, 2)); } catch { /* уже нет */ }
  }
}

export function clearReports() {
  for (const f of readdirSync(dir())) if (f.endsWith('.json')) rmSync(join(dir(), f), { force: true });
}

export const reportsDir = dir;

/** Текст отчёта, который можно скопировать и переслать */
export function reportText(r: CrashReport): string {
  return [
    `Хлопушка ${r.version} · ${new Date(r.at).toLocaleString('ru-RU')}`,
    `Система: ${r.os}`,
    `Что случилось (${r.kind}): ${r.message}`,
    r.stack ? `\n${r.stack}` : '',
    r.log.length ? `\nЖурнал:\n${r.log.join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * Следим за ошибками. Флаг «программа запущена» лежит, пока она работает: если при старте
 * он остался с прошлого раза — значит, программа закрылась не сама (сбой, зависание, выключили свет).
 */
export function watchCrashes(): { unclean: boolean } {
  let unclean = false;
  try {
    unclean = existsSync(runFlag());
    writeFileSync(runFlag(), String(Date.now()));
  } catch { /* нет доступа к папке — не страшно */ }
  if (unclean) saveReport('unclean', 'Прошлый раз программа закрылась неожиданно (сбой, зависание или выключение компьютера)');
  process.on('uncaughtException', e => { saveReport('main', e?.message || String(e), e?.stack); });
  process.on('unhandledRejection', e => { const err = e as Error; saveReport('main', err?.message || String(e), err?.stack); });
  app.on('render-process-gone', (_e, _wc, d) => { if (d.reason !== 'clean-exit') saveReport('window', `Окно программы перезапустилось: ${d.reason} (код ${d.exitCode})`); });
  app.on('child-process-gone', (_e, d) => { if (d.type === 'GPU' && d.reason !== 'clean-exit') saveReport('gpu', `Сбой видеокарты: ${d.reason} (код ${d.exitCode})`); });
  app.on('will-quit', () => { try { rmSync(runFlag(), { force: true }); } catch { /* ничего */ } });
  log(`Запуск ${app.getVersion()} · ${sysInfo()}`);
  return { unclean };
}

/** Отправить отчёты на адрес из настроек (если Максим подключит свой сервер). Возвращает, сколько ушло. */
export async function sendReports(url: string, reports: CrashReport[]): Promise<number> {
  if (!/^https:\/\//.test(url)) throw new Error('Адрес для отчётов не настроен');
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app: 'hlopushka', reports }) });
  if (!res.ok) throw new Error(`Сервер отчётов ответил ${res.status}`);
  markSent(reports.map(r => r.id));
  return reports.length;
}
