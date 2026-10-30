// Переходник MCP для Claude Desktop и других программ, которые умеют запускать сервер только как
// процесс с вводом-выводом (stdio). Запускается самим Kadr.exe в режиме Node (ELECTRON_RUN_AS_NODE=1),
// поэтому отдельно ставить Node.js не нужно. Каждое сообщение из stdin пересылается на HTTP-сервер
// «Кадра», ответы возвращаются в stdout. Пока «Кадр» закрыт, знакомство и список инструментов
// переходник отдаёт сам, а при первом вызове инструмента открывает «Кадр».
import { spawn } from 'node:child_process';
import { MCP_INSTRUCTIONS, TOOLS } from '../shared/tools';

const argv = process.argv.slice(2);
const arg = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const port = Number(arg('--port')) || 7788;
const appExe = arg('--app');
const base = `http://127.0.0.1:${port}`;
const log = (...a: unknown[]) => process.stderr.write('[kadr-bridge] ' + a.join(' ') + '\n');

type Msg = { jsonrpc: '2.0'; id?: string | number | null; method?: string; params?: { protocolVersion?: string } };

const write = (m: unknown) => process.stdout.write(JSON.stringify(m) + '\n');

async function alive(): Promise<boolean> {
  try { return (await fetch(base + '/', { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
}

let launching: Promise<boolean> | null = null;
/** Открыть «Кадр», если он не запущен, и дождаться его сервера */
function ensureApp(): Promise<boolean> {
  if (!launching) {
    launching = (async () => {
      if (await alive()) return true;
      if (!appExe) return false;
      log('«Кадр» не запущен, открываю', appExe);
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      spawn(appExe, [], { detached: true, stdio: 'ignore', env, windowsHide: false }).unref();
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (await alive()) return true;
      }
      return false;
    })().finally(() => { setTimeout(() => { launching = null; }, 0); });
  }
  return launching;
}

/** Ответ без «Кадра»: Claude Desktop знакомится с сервером при каждом своём запуске, открывать ради этого окно не нужно */
function answerOffline(msg: Msg) {
  const reply = (result: unknown) => write({ jsonrpc: '2.0', id: msg.id, result });
  if (msg.method === 'initialize') reply({ protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'kadr', version: '0.1.0' }, instructions: MCP_INSTRUCTIONS });
  else if (msg.method === 'tools/list') reply({ tools: TOOLS.map(t => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema })) });
  else if (msg.method === 'ping') reply({});
}

// Знакомство клиента: «Кадр» узнаёт из него имя ИИ, чтобы подписывать его действия в истории
let initMsg: Msg | null = null;
let introduced = false;

async function forward(msg: Msg) {
  const isRequest = msg.id !== undefined && msg.id !== null && !!msg.method;
  const handshake = msg.method === 'initialize' || msg.method === 'tools/list' || msg.method === 'ping' || !!msg.method?.startsWith('notifications/');
  if (msg.method === 'initialize') initMsg = msg;
  if (handshake && !(await alive())) { answerOffline(msg); return; }
  if (msg.method === 'initialize') introduced = true;
  else if (!handshake && !introduced && initMsg && await ensureApp()) {
    introduced = true;
    await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ ...initMsg, id: 'kadr-bridge-intro' }) })
      .then(r => r.arrayBuffer()).catch(() => undefined);
  }
  const fail = (text: string) => { if (isRequest) write({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: text } }); };
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetch(base + '/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify(msg),
      });
    } catch {
      if (attempt === 0 && await ensureApp()) continue;
      fail('Программа «Кадр» не запущена или выключен MCP-сервер (Настройки → Внешний ИИ). Откройте «Кадр» и повторите.');
      return;
    }
    const type = res.headers.get('content-type') || '';
    if (res.status === 202 || !res.body) return;
    if (type.includes('text/event-stream')) {
      // поток событий: каждое «data:» — отдельное сообщение JSON-RPC
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        let cut: number;
        while ((cut = buf.search(/\r?\n\r?\n/)) >= 0) {
          const event = buf.slice(0, cut);
          buf = buf.slice(cut).replace(/^\r?\n\r?\n/, '');
          const data = event.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
          if (data) process.stdout.write(data.replace(/\n/g, '') + '\n');
        }
      }
      return;
    }
    const text = await res.text();
    if (!text.trim()) { if (!res.ok) fail(`«Кадр» ответил ошибкой ${res.status}`); return; }
    try {
      const body = JSON.parse(text);
      for (const m of Array.isArray(body) ? body : [body]) write(m);
    } catch {
      fail(`«Кадр» ответил ошибкой ${res.status}`);
    }
    return;
  }
}

let pending = 0;
let inputClosed = false;
const maybeExit = () => { if (inputClosed && pending === 0) process.exit(0); };

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buf += chunk;
  let nl: number;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg: Msg;
    try { msg = JSON.parse(line); } catch { log('не JSON:', line.slice(0, 200)); continue; }
    pending++;
    forward(msg).catch(e => log('ошибка:', String(e))).finally(() => { pending--; maybeExit(); });
  }
});
process.stdin.on('end', () => { inputClosed = true; maybeExit(); });
