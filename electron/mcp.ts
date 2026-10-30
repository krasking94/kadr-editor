// MCP: (1) встроенный сервер — через него любой ИИ (Claude, Cursor и др.) управляет «Кадром»;
// (2) клиент — подключает внешние MCP-серверы, их инструменты получает встроенный помощник.
import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MCP_INSTRUCTIONS, TOOLS } from '../shared/tools';
import type { McpClientConfig } from '../shared/settings';
import { callEditor, notify } from './bridge';

// ── Сервер ────────────────────────────────────────────
let httpServer: http.Server | null = null;
let serverState: { running: boolean; port: number; error?: string; lastClient?: string } = { running: false, port: 0 };
// Сервер без сессий: имя клиента приходит только в запросе initialize, запоминаем его
let knownClient = '';

function buildServer(): Server {
  const server = new Server({ name: 'kadr', version: '0.1.0' }, {
    capabilities: { tools: {} },
    instructions: MCP_INSTRUCTIONS,
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(t => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema as any })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async req => {
    const client = server.getClientVersion()?.name || knownClient || 'внешний ИИ';
    if (serverState.lastClient !== client) {
      serverState.lastClient = client;
      notify('mcp:client', { name: client });
    }
    const out = await callEditor(req.params.name, req.params.arguments, client);
    const content: any[] = [];
    if (out.image) content.push({ type: 'image', data: out.image, mimeType: 'image/jpeg' });
    content.push({ type: 'text', text: out.text });
    return { content, isError: !!out.isError };
  });
  return server;
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      try { resolve(raw ? JSON.parse(raw) : undefined); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

export function startMcpServer(port: number): Promise<typeof serverState> {
  stopMcpServer();
  return new Promise(resolve => {
    const srv = http.createServer(async (req, res) => {
      // Защита от чужих сайтов в браузере: принимаем запросы только без Origin или с localhost
      const origin = req.headers.origin;
      if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname === '/' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('Кадр: MCP-сервер работает. Адрес для ИИ: /mcp');
        return;
      }
      if (url.pathname !== '/mcp') { res.writeHead(404).end(); return; }
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }));
        return;
      }
      try {
        const body = await readBody(req) as { method?: string; params?: { clientInfo?: { name?: string } } } | undefined;
        if (body?.method === 'initialize' && body.params?.clientInfo?.name) knownClient = body.params.clientInfo.name;
        const server = buildServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => { transport.close(); server.close(); });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (e) {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: String(e) }, id: null }));
      }
    });
    srv.on('error', err => {
      serverState = { running: false, port, error: (err as NodeJS.ErrnoException).code === 'EADDRINUSE' ? `Порт ${port} занят другой программой` : String(err) };
      resolve(serverState);
    });
    srv.listen(port, '127.0.0.1', () => {
      httpServer = srv;
      serverState = { running: true, port };
      resolve(serverState);
    });
  });
}

export function stopMcpServer(): void {
  httpServer?.close();
  httpServer = null;
  serverState = { running: false, port: serverState.port };
}

export const mcpServerState = () => serverState;

// ── Клиенты внешних MCP-серверов ─────────────────────
interface Connected {
  config: McpClientConfig;
  client?: Client;
  tools: { name: string; description?: string; inputSchema: any }[];
  status: 'connecting' | 'ready' | 'error' | 'off';
  error?: string;
}

const clients = new Map<string, Connected>();

export async function syncClients(configs: McpClientConfig[]): Promise<void> {
  for (const [id, c] of clients) {
    const cfg = configs.find(x => x.id === id);
    if (!cfg || !cfg.enabled || JSON.stringify(cfg) !== JSON.stringify(c.config)) {
      await c.client?.close().catch(() => undefined);
      clients.delete(id);
    }
  }
  await Promise.all(configs.filter(c => c.enabled && !clients.has(c.id)).map(connect));
  notify('mcp:clients', clientStatus());
}

async function connect(config: McpClientConfig): Promise<void> {
  const entry: Connected = { config, tools: [], status: 'connecting' };
  clients.set(config.id, entry);
  try {
    const client = new Client({ name: 'kadr', version: '0.1.0' });
    const transport = config.type === 'http'
      ? new StreamableHTTPClientTransport(new URL(config.url || ''))
      : new StdioClientTransport({ command: config.command || '', args: config.args || [], env: { ...process.env } as Record<string, string> });
    await client.connect(transport);
    const list = await client.listTools();
    entry.client = client;
    entry.tools = list.tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    entry.status = 'ready';
  } catch (e) {
    entry.status = 'error';
    entry.error = String((e as Error)?.message || e);
  }
}

export function clientStatus() {
  return [...clients.values()].map(c => ({ id: c.config.id, name: c.config.name, status: c.status, error: c.error, tools: c.tools.map(t => t.name) }));
}

const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');

// Инструменты внешних серверов для помощника: имя ext__сервер__инструмент
export function externalTools(): { name: string; description: string; inputSchema: any; call: (args: any) => Promise<{ text: string; image?: string; isError?: boolean }> }[] {
  const out: ReturnType<typeof externalTools> = [];
  for (const c of clients.values()) {
    if (c.status !== 'ready' || !c.client) continue;
    for (const t of c.tools) {
      const name = `ext__${safe(c.config.name)}__${safe(t.name)}`.slice(0, 64);
      out.push({
        name,
        description: `[${c.config.name}] ${t.description || t.name}`,
        inputSchema: t.inputSchema?.type ? t.inputSchema : { type: 'object', properties: {} },
        call: async args => {
          const r: any = await c.client!.callTool({ name: t.name, arguments: args });
          let text = '', image: string | undefined;
          for (const part of r.content || []) {
            if (part.type === 'text') text += part.text + '\n';
            else if (part.type === 'image' && !image) image = part.data;
            else if (part.type === 'resource') text += JSON.stringify(part.resource).slice(0, 4000) + '\n';
          }
          return { text: text.trim() || 'Готово', image, isError: !!r.isError };
        },
      });
    }
  }
  return out;
}
