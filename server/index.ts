import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { STARTER_OFFICE } from './office.ts';
import { Sessions } from './sessions.ts';
import { runClaude } from './claude.ts';
import { AzureStore } from './azure.ts';
import { runCodex } from './codex.ts';
import { listSkills } from './skills.ts';
import { listModels } from './models.ts';
import { listDir, readFileView, rawImage } from './files.ts';
import { PinGate } from './auth.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8100;
// Reachable from devices on the local network by default; every new device must enter the PIN once.
const HOST = process.env.HOST || '0.0.0.0';
const exposed = !['127.0.0.1', 'localhost', '::1'].includes(HOST);
const dataDir = process.env.OFFICE_DATA || join(root, 'data');
const gate = new PinGate(process.env.OFFICE_PIN || '8888', dataDir);
const workspace = process.env.OFFICE_WORKSPACE || join(root, 'workspace');

const azureStore = new AzureStore(dataDir);
const sessions = new Sessions(dataDir, {
  azure: () => azureStore.get(),
  run: runClaude,
  runOpenai: runCodex,
  workspace,
  // Hired agents work unattended inside the shared workspace folder.
  permissionMode: process.env.AGENT_PERMISSION_MODE || 'acceptEdits',
  allowedTools: process.env.AGENT_ALLOWED_TOOLS?.split(','),
  autoCompact: Number(process.env.AGENT_COMPACT_TOKENS) || undefined,
});

/** Link for other devices on the network (they are asked for the PIN). */
const phoneUrl = () => {
  for (const addrs of Object.values(networkInterfaces()))
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) return `http://${a.address}:${PORT}/`;
  return '';
};

const clients = new Map<ServerResponse, string>();
const view = (id: string) => {
  const { store, office } = sessions.get(id);
  return JSON.stringify({ ...store.state, workspace: office.currentWorkspace, bossBusy: office.bossBusy, azure: azureStore.public(), sessions: sessions.list(), activeSessionId: id });
};
sessions.onChange(() => {
  for (const [c, id] of clients) c.write(`data: ${view(id)}\n\n`);
});

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

async function body(req: IncomingMessage): Promise<any> {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 1e6) throw new Error('request body too large'); }
  return s ? JSON.parse(s) : {};
}

function json(res: ServerResponse, code: number, data: unknown) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const path = url.pathname;
  try {
    if (path === '/api/unlock' && req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'forbidden origin' });
      const r = gate.attempt(req.socket.remoteAddress ?? '', (await body(req)).pin);
      if (r.ok) { res.setHeader('set-cookie', gate.cookieHeader()); return json(res, 200, { ok: true }); }
      return json(res, r.retryAfterSec ? 429 : 401, r);
    }
    if (!gate.isUnlocked(req.headers.cookie)) {
      if (path.startsWith('/api/')) return json(res, 401, { error: 'locked' });
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }).end(readFileSync(join(root, 'public', 'unlock.html')));
      return;
    }
    if (path.startsWith('/api/')) {
      // Local-only app: refuse cross-site browser requests.
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'forbidden origin' });
      const sessionId = url.searchParams.get('sessionId') || sessions.activeId;

      if (path === '/api/events') {
        sessions.get(sessionId);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(`data: ${view(sessionId)}\n\n`);
        clients.set(res, sessionId);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'GET' && path === '/api/access') return json(res, 200, { url: exposed ? phoneUrl() : '' });
      if (req.method === 'GET' && path === '/api/state') return json(res, 200, JSON.parse(view(sessionId)));
      if (req.method === 'GET' && path === '/api/sessions') return json(res, 200, { sessions: sessions.list(), activeSessionId: sessions.activeId });
      if (req.method === 'POST' && path === '/api/sessions') return json(res, 201, sessions.create(await body(req)));
      let sessionMatch: RegExpMatchArray | null;
      if (req.method === 'POST' && (sessionMatch = path.match(/^\/api\/sessions\/([\w-]+)\/select$/))) {
        const selectedId = sessionMatch[1];
        sessions.get(selectedId);
        return json(res, 200, sessions.list().find((s) => s.id === selectedId));
      }
      if (req.method === 'GET' && path === '/api/azure') return json(res, 200, azureStore.public());
      if (req.method === 'POST' && path === '/api/azure') return json(res, 200, azureStore.set(await body(req)));
      const { store, office } = sessions.get(sessionId);
      if (req.method === 'POST' && path === '/api/usage/reset') { office.resetUsage(); return json(res, 200, { ok: true }); }
      if (req.method === 'POST' && path === '/api/settings') return json(res, 200, office.setSettings(await body(req)));
      if (req.method === 'GET' && path === '/api/models') return json(res, 200, await listModels(url.searchParams.has('refresh')));
      if (req.method === 'GET' && path === '/api/skills') return json(res, 200, listSkills());
      if (req.method === 'GET' && path === '/api/files') return json(res, 200, listDir(office.currentWorkspace, url.searchParams.get('path') ?? ''));
      if (req.method === 'GET' && path === '/api/file') return json(res, 200, readFileView(office.currentWorkspace, url.searchParams.get('path') ?? ''));
      if (req.method === 'GET' && path === '/api/raw') {
        const img = rawImage(office.currentWorkspace, url.searchParams.get('path') ?? '');
        res.writeHead(200, { 'content-type': img.mime, 'content-security-policy': 'sandbox', 'x-content-type-options': 'nosniff' });
        return void res.end(img.data);
      }
      if (req.method === 'GET' && path === '/api/fs') return json(res, 200, office.browse(url.searchParams.get('path') ?? undefined));
      if (req.method === 'POST' && path === '/api/workspace') return json(res, 200, { path: office.setWorkspace((await body(req)).path) });
      if (req.method === 'POST' && path === '/api/chat') {
        const { text } = await body(req);
        if (!String(text ?? '').trim()) return json(res, 400, { error: 'text required' });
        void office.chat(String(text));
        return json(res, 202, { ok: true });
      }
      if (req.method === 'POST' && path === '/api/agents') return json(res, 201, office.hire(await body(req)));
      if (req.method === 'POST' && path === '/api/agents/starter') {
        const have = new Set(store.state.agents.map((a) => a.title));
        for (const a of STARTER_OFFICE) if (!have.has(a.title)) office.hire(a);
        return json(res, 201, { ok: true });
      }
      let m;
      if (req.method === 'PATCH' && (m = path.match(/^\/api\/agents\/([\w-]+)$/))) {
        const id: string = m[1], b = await body(req);
        if (b.skills !== undefined) office.setAgentSkills(id, b.skills);
        if (b.browser !== undefined) return json(res, 200, office.setAgentBrowser(id, !!b.browser));
        return json(res, 200, b.model !== undefined || b.skills === undefined ? office.setAgentModel(id, b.model ?? '') : store.state.agents.find((a) => a.id === id));
      }
      if (req.method === 'DELETE' && (m = path.match(/^\/api\/agents\/([\w-]+)$/))) {
        office.fire(m[1]);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && (m = path.match(/^\/api\/tasks\/([\w-]+)\/cancel$/))) {
        office.cancel(m[1]);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && (m = path.match(/^\/api\/tasks\/([\w-]+)\/retry$/))) {
        office.retry(m[1]);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && (m = path.match(/^\/api\/questions\/([\w-]+)\/answer$/))) {
        office.answer(m[1], (await body(req)).answer);
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'not found' });
    }

    // static files; /vendor/three/* is served from the installed three package (3D office)
    const rel = path === '/' ? 'index.html' : normalize(path).replace(/^(\.\.[/\\])+/, '');
    const vendor = rel.startsWith('/vendor/three/');
    const base = vendor ? join(root, 'node_modules', 'three') : join(root, 'public');
    const file = join(base, vendor ? rel.slice('/vendor/three/'.length) : rel);
    if (!file.startsWith(base) || !existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    // no-cache: browsers revalidate, so UI updates (index.html, office3d.js) show on reload
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(readFileSync(file));
  } catch (e: any) {
    json(res, 400, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Agent Office running at http://localhost:${PORT} (new devices are asked for the PIN)`);
  if (exposed) {
    for (const addrs of Object.values(networkInterfaces()))
      for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) console.log(`On your phone (same Wi-Fi): http://${a.address}:${PORT}/`);
  }
});
process.on('SIGINT', () => {
  sessions.flush();
  process.exit(0);
});
process.on('SIGTERM', () => {
  sessions.flush();
  process.exit(0);
});
