// Подключение «Хлопушки» к Claude Desktop в один клик: запись в его файл настроек
// claude_desktop_config.json сервера, который запускает встроенный переходник (mcp-bridge.js).
import { app } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { writeFileAtomic } from './safe-write';
import { dirname, join } from 'node:path';

export const bridgePath = () => (app.isPackaged ? join(process.resourcesPath, 'mcp-bridge.js') : join(__dirname, 'mcp-bridge.js'));

/** Как Claude Desktop должен запускать «Хлопушка»: сам Hlopushka.exe в режиме Node, без отдельного Node.js */
export function desktopEntry(port: number) {
  const args = [bridgePath(), '--port', String(port)];
  if (app.isPackaged) args.push('--app', process.execPath);
  return { command: process.execPath, args, env: { ELECTRON_RUN_AS_NODE: '1' } };
}

/** Папки настроек Claude Desktop: обычная установка и версия из Microsoft Store */
function claudeDirs(): { dirs: string[]; installed: boolean } {
  const main = join(app.getPath('appData'), 'Claude');
  const dirs: string[] = [];
  if (existsSync(main)) dirs.push(main);
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const pk = join(process.env.LOCALAPPDATA, 'Packages');
    try {
      for (const d of readdirSync(pk)) {
        if (!/^(AnthropicPBC\.)?Claude_/i.test(d)) continue;
        const p = join(pk, d, 'LocalCache', 'Roaming', 'Claude');
        if (existsSync(p)) dirs.push(p);
      }
    } catch { /* папки может не быть */ }
  }
  return { dirs: dirs.length ? dirs : [main], installed: dirs.length > 0 };
}

type Config = { mcpServers?: Record<string, unknown>; [k: string]: unknown };

function readConfig(file: string): Config {
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, 'utf8').replace(/^﻿/, '').trim();
  return raw ? JSON.parse(raw) : {};
}

// Имя сервера в настройках Claude Desktop. До версии 0.3 программа называлась «Кадр»
export const SERVER_KEY = 'hlopushka';
const OLD_KEY = 'kadr';

export function desktopStatus(port: number) {
  const { dirs, installed } = claudeDirs();
  const want = JSON.stringify(desktopEntry(port));
  const files = dirs.map(d => join(d, 'claude_desktop_config.json'));
  let connected = false, outdated = false;
  for (const f of files) {
    try {
      const servers = readConfig(f).mcpServers;
      const k = servers?.[SERVER_KEY];
      if (k) { if (JSON.stringify(k) === want) connected = true; else outdated = true; }
      else if (servers?.[OLD_KEY]) outdated = true; // подключали ещё под старым именем «Кадр»
    } catch { /* испорченный файл покажем при подключении */ }
  }
  return { installed, connected, outdated: outdated && !connected, files };
}

export function connectClaudeDesktop(port: number): { ok: boolean; files: string[]; error?: string } {
  const { dirs } = claudeDirs();
  const files: string[] = [];
  for (const d of dirs) {
    const file = join(d, 'claude_desktop_config.json');
    let cfg: Config;
    try { cfg = readConfig(file); } catch {
      return { ok: false, files, error: `Файл настроек Claude испорчен, я не стал его трогать: ${file}` };
    }
    if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) return { ok: false, files, error: `Непонятный файл настроек Claude: ${file}` };
    const servers = { ...(cfg.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : {}) } as Record<string, unknown>;
    delete servers[OLD_KEY]; // запись от версии 0.2, когда программа называлась «Кадр»
    cfg.mcpServers = { ...servers, [SERVER_KEY]: desktopEntry(port) };
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileAtomic(file, JSON.stringify(cfg, null, 2), { backup: true });
      files.push(file);
    } catch (e) {
      return { ok: false, files, error: `Не удалось записать ${file}: ${String(e)}` };
    }
  }
  return { ok: true, files };
}

/** Проверка переходника так же, как его запустит Claude Desktop: initialize и список инструментов */
export function bridgeSelfTest(port: number): Promise<{ ok: boolean; tools?: number; error?: string }> {
  return new Promise(resolve => {
    const e = desktopEntry(port);
    const args = e.args.filter((_, i, a) => a[i] !== '--app' && a[i - 1] !== '--app');
    const child = spawn(e.command, args, { env: { ...process.env, ...e.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const done = (r: { ok: boolean; tools?: number; error?: string }) => { clearTimeout(t); child.kill(); resolve(r); };
    const t = setTimeout(() => done({ ok: false, error: 'timeout ' + err.slice(0, 300) }), 20000);
    child.stderr.on('data', d => { err += d; });
    child.on('error', x => done({ ok: false, error: String(x) }));
    child.stdout.on('data', d => {
      out += d;
      for (const line of out.split('\n')) {
        try {
          const m = JSON.parse(line);
          if (m.id === 1) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
          if (m.id === 2) done({ ok: Array.isArray(m.result?.tools) && m.result.tools.length > 0, tools: m.result?.tools?.length, error: m.error?.message });
        } catch { /* строка ещё не полная */ }
      }
      out = out.slice(out.lastIndexOf('\n') + 1);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Проверка переходника', version: '1' } } }) + '\n');
  });
}
