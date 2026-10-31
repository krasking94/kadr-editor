// Надёжная запись файлов. Сначала пишем во временный файл рядом, сбрасываем на диск и только потом
// подменяем им старый. Если в этот момент выключат свет или программа упадёт, на диске останется
// либо старая версия, либо новая — но не обрезанный наполовину файл.
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const pause = (ms: number) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* без паузы */ } };

/**
 * Записать файл целиком или не трогать его вовсе.
 * backup — сохранить предыдущую версию рядом (file.bak): её подхватит readJsonSafe, если основной файл испорчен.
 */
export function writeFileAtomic(path: string, data: string | Uint8Array, opts: { backup?: boolean } = {}): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (opts.backup && existsSync(path)) {
    try { copyFileSync(path, path + '.bak'); } catch { /* копия не обязательна */ }
  }
  // В Windows файл может быть на миг занят антивирусом или облачной папкой (OneDrive, Яндекс Диск) — пробуем ещё
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i < 6 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) { pause(60 * (i + 1)); continue; }
      // подменить не дали — записываем поверх (так программа работала раньше), временный файл убираем
      try {
        copyFileSync(tmp, path);
      } finally {
        try { unlinkSync(tmp); } catch { /* уже нет */ }
      }
      return;
    }
  }
}

/** Прочитать JSON; если файл испорчен или пропал — взять предыдущую версию (file.bak) */
export function readJsonSafe<T>(path: string): T | null {
  for (const p of [path, path + '.bak']) {
    try {
      if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')) as T;
    } catch { /* пробуем копию */ }
  }
  return null;
}
