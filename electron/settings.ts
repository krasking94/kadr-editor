// Хранение настроек и ключей нейросетей. Ключи шифруются средствами Windows (safeStorage).
import { app, safeStorage } from 'electron';
import { join } from 'node:path';
import { readJsonSafe, writeFileAtomic } from './safe-write';
import { defaultBrand, defaultPrompter, defaultPublish, defaultSettings, type Settings } from '../shared/settings';

const file = () => join(app.getPath('userData'), 'settings.json');
const secretsFile = () => join(app.getPath('userData'), 'keys.json');

let cache: Settings | null = null;

export function getSettings(): Settings {
  if (cache) return cache;
  const base = defaultSettings();
  try {
    const saved = readJsonSafe<any>(file()); // испорчен — берём предыдущую версию
    if (saved) {
      cache = { ...base, ...saved, ai: { ...base.ai, ...saved.ai }, gen: { ...base.gen, ...saved.gen }, mcp: { ...base.mcp, ...saved.mcp }, brand: { ...defaultBrand(), ...saved.brand }, publish: { ...defaultPublish(), ...saved.publish }, reports: { ...base.reports, ...saved.reports }, prompter: { ...defaultPrompter(), ...saved.prompter } };
      return cache!;
    }
  } catch { /* повреждённый файл — начинаем с настроек по умолчанию */ }
  cache = base;
  return cache;
}

export function setSettings(patch: Partial<Settings>): Settings {
  const cur = getSettings();
  cache = { ...cur, ...patch, ai: { ...cur.ai, ...(patch.ai || {}) }, gen: { ...cur.gen, ...(patch.gen || {}) }, mcp: { ...cur.mcp, ...(patch.mcp || {}) }, brand: { ...cur.brand, ...(patch.brand || {}) }, publish: { ...cur.publish, ...(patch.publish || {}) }, reports: { ...cur.reports, ...(patch.reports || {}) }, prompter: { ...cur.prompter, ...(patch.prompter || {}) } };
  writeFileAtomic(file(), JSON.stringify(cache, null, 2), { backup: true });
  return cache;
}

function readSecrets(): Record<string, string> {
  return readJsonSafe<Record<string, string>>(secretsFile()) || {};
}

export function setSecret(id: string, value: string): void {
  const all = readSecrets();
  if (!value) delete all[id];
  else if (safeStorage.isEncryptionAvailable()) all[id] = 'enc:' + safeStorage.encryptString(value).toString('base64');
  else all[id] = 'b64:' + Buffer.from(value).toString('base64');
  writeFileAtomic(secretsFile(), JSON.stringify(all, null, 2), { backup: true });
}

export function getSecret(id: string): string {
  const v = readSecrets()[id];
  if (!v) return '';
  try {
    if (v.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'));
    if (v.startsWith('b64:')) return Buffer.from(v.slice(4), 'base64').toString();
  } catch { /* ключ от другой учётной записи Windows */ }
  return '';
}

export function secretStatus(): Record<string, boolean> {
  const all = readSecrets();
  return Object.fromEntries(Object.keys(all).map(k => [k, true]));
}
