import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, realpathSync, existsSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { PiAgent, CodexAgent } from './agents.js';

const here = dirname(fileURLToPath(import.meta.url));
const clipped = value => String(value ?? '').slice(0, 200000);
export function createBridge({ root = process.cwd(), dataDir = resolve(root, '.lan-agent'), token, advertisedUrl, agentFactory, quiet = false } = {}) {
  root = realpathSync(root); mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const tokenPath = resolve(dataDir, 'token');
  token ||= existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : randomBytes(24).toString('base64url');
  if (token.length < 24) throw new Error('Pairing token must be at least 24 characters');
  writeFileSync(tokenPath, token + '\n', { mode: 0o600 });
  const sessions = new Map(), clients = new Set();
  const metadataPath = resolve(dataDir, 'sessions.json');
  if (existsSync(metadataPath)) {
    let saved;
    try { saved = JSON.parse(readFileSync(metadataPath, 'utf8')); }
    catch (e) { throw new Error(`Session metadata is damaged; preserve ${metadataPath} before recovery: ${e.message}`); }
    for (const s of saved) {
      let events = [];
      const path = resolve(dataDir, `${s.id}.jsonl`);
      if (existsSync(path)) events = readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      sessions.set(s.id, { ...s, status: 'offline', events: events.slice(-10000), seq: events.at(-1)?.seq || 0, choices: new Map(), agent: null, busy: false, turns: events.filter(e => e.event === 'user').length, tools: events.filter(e => e.event === 'tool' && e.status === 'start').length });
    }
  }
  function summary(s) { return { id: s.id, agent: s.kind, title: s.title, cwd: s.cwd, status: s.status, model: s.model, models: s.models, seq: s.seq, turns: s.turns, tools: s.tools }; }
  function save() { writeFileSync(metadataPath, JSON.stringify([...sessions.values()].map(s => ({ id: s.id, kind: s.kind, title: s.title, cwd: s.cwd, model: s.model, models: s.models }))), { mode: 0o600 }); }
  function send(ws, data) { if (ws.readyState !== WebSocket.OPEN) return; if (ws.bufferedAmount > 8 * 1024 * 1024) return ws.close(1013, 'Client too slow; reconnect for replay'); ws.send(JSON.stringify(data)); }
  function broadcast(data) { for (const ws of clients) send(ws, data); }
  function event(s, type, payload = {}) {
    if (type === 'status') s.status = payload.status;
    if (type === 'choice') { s.choices.set(payload.requestId, payload); s.status = 'waiting'; }
    if (type === 'choice_closed') { s.choices.delete(payload.requestId); if (!s.choices.size && s.status === 'waiting') s.status = 'running'; }
    if (type === 'completed') s.status = payload.status;
    if (type === 'error' && payload.fatal) s.status = 'error';
    if (type === 'tool' && payload.status === 'start') s.tools++;
    if (type === 'user') s.turns++;
    const record = { type: 'event', sessionId: s.id, seq: ++s.seq, timestamp: Date.now(), event: type, ...payload };
    s.events.push(record); if (s.events.length > 10000) s.events.shift();
    appendFileSync(resolve(dataDir, `${s.id}.jsonl`), JSON.stringify(record) + '\n', { mode: 0o600 });
    broadcast(record);
    if (['status', 'choice', 'choice_closed', 'completed', 'error', 'model', 'user', 'tool'].includes(type)) broadcast({ type: 'sessions', sessions: [...sessions.values()].map(summary) });
    if (!quiet && ['user', 'tool', 'choice', 'completed', 'error'].includes(type)) console.log(`[${s.kind}:${s.id.slice(0, 8)}] ${type} ${payload.text?.slice(0, 100) || payload.title || payload.name || payload.status || ''}`);
    return record;
  }
  function validCwd(input) {
    const cwd = realpathSync(resolve(root, input || '.')), diff = relative(root, cwd);
    if (diff === '..' || diff.startsWith('../') || isAbsolute(diff)) throw new Error('Working directory must be inside bridge root');
    return cwd;
  }
  function snapshot(s) { return { ...summary(s), choices: [...s.choices.values()], events: s.events }; }
  function authenticated(value) { const a = Buffer.from(String(value || '')), b = Buffer.from(token); return a.length === b.length && timingSafeEqual(a, b); }
  const server = http.createServer((req, res) => {
    let u;
    try { u = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); res.end(); return; }
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    if (u.pathname === '/health') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, version: '1.0.0' })); return; }
    if (u.pathname === '/app.apk') {
      const apk = resolve(here, '../../artifacts/lan-agent-1.0.0.apk');
      if (!existsSync(apk)) { res.writeHead(404); res.end('APK not built yet'); return; }
      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      res.setHeader('Content-Disposition', 'attachment; filename="lan-agent-1.0.0.apk"');
      res.setHeader('X-Content-Type-Options', 'nosniff'); res.end(readFileSync(apk)); return;
    }
    const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
    const file = files[u.pathname]; if (!file) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', file[1]); res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'");
    res.end(readFileSync(resolve(here, '../public', file[0])));
  });
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 * 1024 });
  wss.on('connection', (ws, req) => {
    try { if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) { ws.close(1008, 'Origin rejected'); return; } }
    catch { ws.close(1008, 'Invalid origin'); return; }
    ws.isAlive = true; ws.authed = false;
    const deadline = setTimeout(() => ws.close(1008, 'Authenticate first'), 10000);
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('close', () => { clearTimeout(deadline); clients.delete(ws); });
    ws.on('error', () => {});
    ws.on('message', async bytes => {
      let command;
      try {
        command = JSON.parse(bytes.toString());
        if (!ws.authed) {
          if (command.type !== 'auth' || !authenticated(command.token)) { ws.close(1008, 'Invalid pairing token'); return; }
          ws.authed = true; clearTimeout(deadline); clients.add(ws);
          send(ws, { type: 'hello', version: '1.0.0', root, sessions: [...sessions.values()].map(summary) }); return;
        }
        const result = await handle(command); send(ws, { type: 'response', id: command.id, ok: true, data: result });
      } catch (e) { send(ws, { type: 'response', id: command?.id, ok: false, error: e.message }); }
    });
  });
  async function handle(c) {
    if (c.type === 'list') return [...sessions.values()].map(summary);
    if (c.type === 'pair') {
      const url = advertisedUrl || `http://127.0.0.1:${server.address().port}`;
      const payload = JSON.stringify({ version: 1, url, token });
      return { url, token, qr: await QRCode.toDataURL(payload), payload };
    }
    if (c.type === 'create') {
      if (!['pi', 'codex'].includes(c.agent)) throw new Error('Choose pi or codex');
      if ([...sessions.values()].filter(s => s.agent && !s.agent.closed).length >= 8) throw new Error('Maximum 8 active sessions');
      const s = { id: randomUUID(), kind: c.agent, title: clipped(c.title || `${c.agent} · ${new Date().toLocaleTimeString()}`).slice(0, 120), cwd: validCwd(c.cwd), status: 'starting', models: [], model: '', events: [], seq: 0, choices: new Map(), busy: true, tools: 0, turns: 0 };
      sessions.set(s.id, s); broadcast({ type: 'sessions', sessions: [...sessions.values()].map(summary) });
      try {
        s.agent = agentFactory ? agentFactory(s.kind, s.cwd, (type, data) => event(s, type, data)) : new (s.kind === 'pi' ? PiAgent : CodexAgent)(s.cwd, (type, data) => event(s, type, data));
        const info = await s.agent.init(); s.models = info.models; s.model = info.model; s.status = 'idle'; save();
        event(s, 'status', { status: 'idle' }); return snapshot(s);
      } catch (e) { s.agent?.close(); event(s, 'error', { text: e.message, fatal: true }); save(); throw e; }
      finally { s.busy = false; }
    }
    const s = sessions.get(c.sessionId); if (!s) throw new Error('Session not found');
    if (c.type === 'subscribe') return snapshot(s);
    if (c.type === 'close') { if (s.busy) throw new Error('Session is processing a command'); s.agent?.close(); s.agent = null; for (const requestId of s.choices.keys()) event(s, 'choice_closed', { requestId }); event(s, 'status', { status: 'offline' }); save(); return summary(s); }
    if (!s.agent || s.agent.closed) throw new Error('Session offline; create a new session to continue');
    if (c.type === 'abort') { await s.agent.abort(); return {}; }
    // A Pi extension command can await UI before its prompt response. Answers must bypass that command lock.
    if (c.type === 'answer') {
      if (!s.choices.has(c.requestId)) throw new Error('Request expired or already answered');
      await s.agent.answer(c.requestId, c.answer || {}); event(s, 'choice_closed', { requestId: c.requestId }); return {};
    }
    if (s.busy) throw new Error('Previous command is still being processed');
    s.busy = true;
    try {
      if (c.type === 'prompt') {
        if (['running', 'waiting', 'starting'].includes(s.status)) throw new Error('Wait for completion or stop the current task first');
        if (typeof c.text !== 'string' || !c.text.trim() || c.text.length > 100000) throw new Error('Message must contain 1–100000 characters');
        event(s, 'user', { text: c.text }); event(s, 'status', { status: 'running' });
        try { await s.agent.prompt(c.text); } catch (e) { event(s, 'error', { text: e.message }); event(s, 'status', { status: 'error' }); throw e; }
        return {};
      }
      if (c.type === 'model') {
        if (['running', 'waiting'].includes(s.status)) throw new Error('Cannot switch model during a task');
        if (!s.models.some(m => m.id === c.model)) throw new Error('Model is not in the available model list');
        await s.agent.model(c.model); s.model = c.model; save(); event(s, 'model', { model: s.model }); return summary(s);
      }
      throw new Error('Unknown command');
    } finally { s.busy = false; }
  }
  const heartbeat = setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }, 25000); heartbeat.unref();
  return { server, sessions, token, handle, async close() { clearInterval(heartbeat); for (const s of sessions.values()) s.agent?.close(); for (const ws of wss.clients) ws.terminate(); await new Promise(r => wss.close(r)); await new Promise(r => server.close(r)); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.env.AGENT_ROOT || process.cwd());
  const port = Number(process.env.PORT || 8787), host = process.env.HOST || '0.0.0.0';
  const advertisedUrl = process.env.LAN_URL || `http://127.0.0.1:${port}`;
  const bridge = createBridge({ root, dataDir: resolve(process.env.DATA_DIR || resolve(root, '.lan-agent')), token: process.env.PAIR_TOKEN, advertisedUrl });
  bridge.server.listen(port, host, async () => {
    console.log(`\nLAN Agent · root ${root}\n电脑面板: http://localhost:${port}\n手机连接: ${advertisedUrl}\n配对码: ${bridge.token}\n只在可信局域网使用；不要将端口暴露到公网。`);
    if (!process.env.LAN_URL) console.log('设置 LAN_URL=http://Windows局域网IP:8787，二维码才可从手机访问。');
    console.log(await QRCode.toString(JSON.stringify({ version: 1, url: advertisedUrl, token: bridge.token }), { type: 'terminal', small: true }));
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await bridge.close(); process.exit(0); });
}
