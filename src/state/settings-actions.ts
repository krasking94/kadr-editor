// Сохранение настроек и применение темы оформления.
import { api } from '../api';
import type { Settings } from '../../shared/settings';
import { get, set } from './store';

export async function loadSettings() {
  const r = await api.getSettings();
  set({ settings: r.settings, secrets: r.secrets });
  applyTheme(r.settings);
}

export async function saveSettings(patch: Partial<Settings>) {
  // сразу показываем изменение, затем сохраняем на диск
  const merged = { ...get().settings, ...patch } as Settings;
  set({ settings: merged });
  applyTheme(merged);
  const saved = await api.setSettings(patch);
  set({ settings: saved });
}

export async function saveSecret(id: string, value: string) {
  const status = await api.setSecret(id, value);
  set({ secrets: status });
}

let media: MediaQueryList | null = null;
export function applyTheme(s: Settings) {
  media ??= window.matchMedia('(prefers-color-scheme: light)');
  const light = s.theme === 'light' || (s.theme === 'system' && media.matches);
  const root = document.documentElement;
  root.dataset.theme = light ? 'light' : 'dark';
  root.style.setProperty('--accent', s.accent || '#7c5cff');
  // кнопки окна Windows (свернуть, развернуть, закрыть) в цвет темы
  api.setTitlebar(light ? '#eef0f5' : '#0b0c10', light ? '#171923' : '#ecedf3');
}

export function watchSystemTheme() {
  media ??= window.matchMedia('(prefers-color-scheme: light)');
  const h = () => applyTheme(get().settings);
  media.addEventListener('change', h);
  return () => media!.removeEventListener('change', h);
}
