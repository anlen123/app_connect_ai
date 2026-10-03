import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { accessSync, constants, mkdirSync, readFileSync, writeFileSync, appendFileSync, realpathSync, existsSync, statSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute, delimiter } from 'node:path';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { PiAgent, CodexAgent } from './agents.js';
import { VERSION, ANDROID_VERSION } from './version.js';
import { recoverNative } from './session-recovery.js';
import { validatePairingCode, savePairingCode } from './pairing-code.js';

const here = dirname(fileURLToPath(import.meta.url));
const apkPath = resolve(here, `../../artifacts/lan-agent-${ANDROID_VERSION}.apk`);
export function agentCatalog() {
  function available(command) {
    const candidates = command.includes('/') ? [command] : (process.env.PATH || '').split(delimiter).map(dir => resolve(dir, command));
    return candidates.some(path => { try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; } });
  }
  return [{ id: 'pi', name: 'Pi', available: available(process.env.PI_BIN || 'pi'), description: 'Pi RPC · 可扩展编程助手' }, { id: 'codex', name: 'Codex', available: available(process.env.CODEX_BIN || 'codex'), description: 'Codex app-server · 代码与任务助手' }];
}
export function linuxLanUrl(port) {
  const entries = Object.entries(networkInterfaces()).flatMap(([name, addresses]) => (addresses || []).filter(a => a.family === 'IPv4' && !a.internal).map(a => ({ name, address: a.address })));
  const primary = entries.find(a => !/^(docker|veth|br-|virbr)/.test(a.name)) || entries[0];
  return `http://${primary?.address || '127.0.0.1'}:${port}`;
}

export function createBridge({ root = process.cwd(), dataDir = resolve(root, '.lan-agent'), token, advertisedUrl, agentFactory, quiet = false } = {}) {
  root = realpathSync(root);
  if (!statSync(root).isDirectory()) throw new Error('AGENT_ROOT 必须是 Linux 上存在的目录');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const tokenPath = resolve(dataDir, 'token');
  token ||= existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : randomBytes(24).toString('base64url');
  token = validatePairingCode(token);
  savePairingCode(dataDir, token);
  const sessions = new Map(), clients = new Set();
  const metadataPath = resolve(dataDir, 'sessions.json');
  if (existsSync(metadataPath)) {
    let saved;
    try { saved = JSON.parse(readFileSync(metadataPath, 'utf8')); }
    catch (e) { throw new Error(`会话索引损坏，请保留 ${metadataPath} 后恢复：${e.message}`); }
    if (!Array.isArray(saved)) throw new Error('会话索引格式错误');
    for (const s of saved) {
      if (!/^[0-9a-f-]{36}$/.test(s.id) || !['pi', 'codex'].includes(s.kind)) continue;
      let events = [];
      const path = resolve(dataDir, `${s.id}.jsonl`);
      if (existsSync(path)) events = readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      sessions.set(s.id, { ...s, status: 'offline', events: events.slice(-10000), seq: events.at(-1)?.seq || 0, choices: new Map(), agent: null, initialized: false, busy: false, turns: events.filter(e => e.event === 'user').length, tools: events.filter(e => e.event === 'tool' && e.status === 'start').length });
    }
  }
  function catalog() { return agentFactory ? agentCatalog().map(a => ({ ...a, available: true })) : agentCatalog(); }
  function summary(s) { return { id: s.id, agent: s.kind, title: s.title, cwd: s.cwd, status: s.status, model: s.model, models: s.models, seq: s.seq, turns: s.turns, tools: s.tools, active: Boolean(s.agent && !s.agent.closed), ready: Boolean(s.initialized && s.agent && !s.agent.closed) }; }
  function save() {
    const data = [...sessions.values()].map(s => ({ id: s.id, kind: s.kind, title: s.title, cwd: s.cwd, model: s.model, models: s.models, native: s.native }));
    writeFileSync(`${metadataPath}.tmp`, JSON.stringify(data), { mode: 0o600 });
    renameSync(`${metadataPath}.tmp`, metadataPath);
  }
  function send(ws, data) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 8 * 1024 * 1024) { ws.close(1013, 'Client too slow; reconnect for replay'); return; }
    ws.send(JSON.stringify(data));
  }
  function broadcast(data) { for (const ws of clients) send(ws, data); }
  function broadcastSessions() { broadcast({ type: 'sessions', sessions: [...sessions.values()].map(summary) }); }
  function event(s, type, payload = {}) {
    // A late callback from a deleted process must never recreate its history file.
    if (s.deleted) return;
    if (['delta', 'content'].includes(type) && payload.channel === 'thinking' && (typeof payload.text !== 'string' || !payload.text.length)) return;
    // Extension startup widgets are not task progress.
    if (['progress', 'plan', 'activity'].includes(type) && !['running', 'waiting'].includes(s.status)) return;
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
    if (['status', 'choice', 'choice_closed', 'completed', 'error', 'model', 'user', 'tool'].includes(type)) broadcastSessions();
    if (!quiet && ['user', 'tool', 'choice', 'completed', 'error'].includes(type)) console.log(`[${s.kind}:${s.id.slice(0, 8)}] ${type} ${payload.title || payload.name || payload.status || ''}`);
    return record;
  }
  function validCwd(input) {
    if (input != null && typeof input !== 'string') throw new Error('目录必须是字符串');
    let cwd;
    try { cwd = realpathSync(resolve(root, input || '.')); } catch { throw new Error('项目目录不存在，请填写 Linux 服务根目录内的文件夹'); }
    const diff = relative(root, cwd);
    if (diff === '..' || diff.startsWith('../') || isAbsolute(diff)) throw new Error('Working directory must be inside bridge root');
    if (!statSync(cwd).isDirectory()) throw new Error('项目目录必须是文件夹，不能选择文件');
    return cwd;
  }
  function snapshot(s) { return { ...summary(s), choices: [...s.choices.values()], events: s.events }; }
  function authenticated(value) { const a = Buffer.from(String(value || '')), b = Buffer.from(token); return a.length === b.length && timingSafeEqual(a, b); }
  function originFor(req) {
    try {
      if (req.headers.origin) {
        const origin = new URL(req.headers.origin);
        if (['http:', 'https:'].includes(origin.protocol) && origin.host === req.headers.host) return origin.origin;
      }
      const scheme = req.socket.encrypted ? 'https' : 'http';
      return new URL(`${scheme}://${req.headers.host}`).origin;
    } catch { return ''; }
  }
  function lanAddress(origin = '') {
    if (advertisedUrl) return advertisedUrl.replace(/\/$/, '');
    try { if (origin && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)) return origin; } catch { /* fall back to a Linux interface */ }
    return linuxLanUrl(server.address()?.port || 8787);
  }
  const server = http.createServer((req, res) => {
    let u;
    try { u = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); res.end(); return; }
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    if (u.pathname === '/health') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, version: VERSION })); return; }
    if (u.pathname === '/app.apk') {
      if (!existsSync(apkPath)) { res.writeHead(404); res.end('可直接使用手机浏览器；可选 APK 请从 GitHub Release 下载。'); return; }
      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      res.setHeader('Content-Disposition', `attachment; filename="lan-agent-${ANDROID_VERSION}.apk"`);
      res.setHeader('X-Content-Type-Options', 'nosniff'); res.end(readFileSync(apkPath)); return;
    }
    const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/markdown.js': ['markdown.js', 'text/javascript; charset=utf-8'], '/vendor/marked.js': ['vendor/marked.js', 'text/javascript; charset=utf-8'], '/vendor/purify.js': ['vendor/purify.js', 'text/javascript; charset=utf-8'] };
    const file = files[u.pathname]; if (!file) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', file[1]); res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'");
    res.end(readFileSync(resolve(here, '../public', file[0])));
  });
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 * 1024 });
  const authFailures = new Map();
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
        if (!command || typeof command !== 'object' || typeof command.type !== 'string') throw new Error('Invalid command');
        if (!ws.authed) {
          const ip = req.socket.remoteAddress, now = Date.now();
          const failure = authFailures.get(ip);
          if (failure && now - failure.time < 300000 && failure.count >= 5) { ws.close(1008, 'Too many login attempts; retry in 5 minutes'); return; }
          if (command.type !== 'auth' || !authenticated(command.token)) {
            if (authFailures.size >= 1000) authFailures.delete(authFailures.keys().next().value);
            authFailures.set(ip, { time: failure && now - failure.time < 300000 ? failure.time : now, count: failure && now - failure.time < 300000 ? failure.count + 1 : 1 });
            ws.close(1008, 'Invalid pairing token'); return;
          }
          authFailures.delete(ip);
          ws.authed = true; clearTimeout(deadline); clients.add(ws);
          send(ws, { type: 'hello', version: VERSION, root, agents: catalog(), lanUrl: lanAddress(originFor(req)), apkAvailable: existsSync(apkPath), sessions: [...sessions.values()].map(summary) }); return;
        }
        const result = await handle(command, { origin: originFor(req) });
        send(ws, { type: 'response', id: command.id, ok: true, data: result });
      } catch (e) { send(ws, { type: 'response', id: command?.id, ok: false, error: e.message }); }
    });
  });
  async function startAgent(s, model) {
    if ([...sessions.values()].filter(other => other !== s && (other.status === 'starting' || other.agent && !other.agent.closed)).length >= 8) throw new Error('最多 8 个运行中的 agent，请先关闭或删除不用的会话');
    const native = agentFactory ? s.native : recoverNative(s);
    s.cwd = validCwd(s.cwd);
    const sessionDir = resolve(dataDir, 'native', s.id);
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    s.busy = true; s.initialized = false;
    const generation = s.generation = (s.generation || 0) + 1;
    event(s, 'status', { status: 'starting' });
    try {
      if (s.agent) await s.agent.close();
      if (s.deleted) throw new Error('会话已被删除');
      const emit = (type, data) => { if (s.generation === generation && !s.deleted) event(s, type, data); };
      const options = { native, sessionDir };
      s.agent = agentFactory ? agentFactory(s.kind, s.cwd, emit, options) : new (s.kind === 'pi' ? PiAgent : CodexAgent)(s.cwd, emit, options);
      const info = await s.agent.init();
      if (s.deleted) throw new Error('会话已被删除');
      s.native = info.native || native; s.models = info.models; s.model = info.model;
      save();
      if (model) {
        if (!s.models.some(m => m.id === model)) throw new Error('所选模型不在该 agent 的可用列表中');
        await s.agent.model(model); s.model = model;
      }
      if (s.deleted) throw new Error('会话已被删除');
      s.initialized = true; save(); event(s, 'status', { status: 'idle' }); return snapshot(s);
    } catch (e) {
      await s.agent?.close();
      if (!s.deleted) { event(s, 'error', { text: e.message, fatal: true }); save(); }
      throw e;
    } finally { s.busy = false; }
  }
  async function handle(c, context = {}) {
    if (c.type === 'list') return [...sessions.values()].map(summary);
    if (c.type === 'agents') return catalog();
    if (c.type === 'pair') {
      const url = lanAddress(context.origin), browserUrl = c.includeCredentials === false ? `${url}/` : `${url}/#token=${encodeURIComponent(token)}`;
      const payload = JSON.stringify({ version: 1, url, token });
      return { url, token, qr: await QRCode.toDataURL(payload), payload, browserUrl, webQr: await QRCode.toDataURL(browserUrl) };
    }
    if (c.type === 'create') {
      if (!['pi', 'codex'].includes(c.agent)) throw new Error('请选择 pi 或 codex');
      if (!catalog().find(a => a.id === c.agent)?.available) throw new Error(`Linux 服务上未找到 ${c.agent}，请先安装该 CLI 并登录`);
      if ([...sessions.values()].filter(s => s.status === 'starting' || s.agent && !s.agent.closed).length >= 8) throw new Error('最多 8 个运行中的 agent，请先关闭或删除不用的会话');
      const title = typeof c.title === 'string' && c.title.trim() ? c.title.trim().slice(0, 120) : `${c.agent} · ${new Date().toLocaleTimeString()}`;
      const s = { id: randomUUID(), kind: c.agent, title, cwd: validCwd(c.cwd), status: 'starting', models: [], model: '', events: [], seq: 0, choices: new Map(), initialized: false, busy: true, tools: 0, turns: 0 };
      sessions.set(s.id, s); save(); broadcastSessions();
      return startAgent(s, c.model);
    }
    const s = sessions.get(c.sessionId); if (!s) throw new Error('会话不存在，可能已在另一端删除');
    if (c.type === 'subscribe') return snapshot(s);
    if (c.type === 'rename') {
      if (typeof c.title !== 'string' || !c.title.trim() || c.title.trim().length > 120) throw new Error('会话名称须为 1–120 个字符');
      s.title = c.title.trim(); save(); broadcastSessions(); return summary(s);
    }
    if (c.type === 'delete') {
      s.deleted = true; sessions.delete(s.id);
      try { save(); } catch (e) { s.deleted = false; sessions.set(s.id, s); throw e; }
      await s.agent?.close(); s.agent = null; s.choices.clear();
      rmSync(resolve(dataDir, `${s.id}.jsonl`), { force: true });
      rmSync(resolve(dataDir, 'native', s.id), { recursive: true, force: true });
      broadcast({ type: 'session_deleted', sessionId: s.id }); broadcastSessions();
      return { deleted: true, sessionId: s.id };
    }
    if (c.type === 'restart') {
      if (s.busy) throw new Error('会话正在处理命令，请稍候');
      if (s.agent && !s.agent.closed) throw new Error('会话进程仍在运行，请先关闭进程');
      if (!catalog().find(a => a.id === s.kind)?.available) throw new Error(`Linux 服务上未找到 ${s.kind}`);
      for (const requestId of s.choices.keys()) event(s, 'choice_closed', { requestId });
      return startAgent(s, s.model);
    }
    if (c.type === 'close') {
      if (s.busy) throw new Error('会话正在处理命令，可以先停止任务或选择删除会话');
      s.busy = true; s.initialized = false; s.generation = (s.generation || 0) + 1;
      event(s, 'status', { status: 'closing' });
      try {
        await s.agent?.close(); s.agent = null; s.generation = (s.generation || 0) + 1;
        for (const requestId of s.choices.keys()) event(s, 'choice_closed', { requestId });
        event(s, 'status', { status: 'offline' }); save(); return summary(s);
      } finally { s.busy = false; }
    }
    if (!s.agent || s.agent.closed || !s.initialized) throw new Error('会话进程未就绪或已停止，请点击重启进程；历史仍可查看');
    if (c.type === 'abort') { await s.agent.abort(); return {}; }
    // UI answers must bypass the pending prompt lock (Pi commands can await a dialog).
    if (c.type === 'answer') {
      if (!s.choices.has(c.requestId)) throw new Error('请求已过期或已回答');
      await s.agent.answer(c.requestId, c.answer || {}); event(s, 'choice_closed', { requestId: c.requestId }); return {};
    }
    if (s.busy) throw new Error('上一条命令仍在处理，请稍后');
    s.busy = true;
    try {
      if (c.type === 'prompt') {
        if (['running', 'waiting', 'starting'].includes(s.status)) throw new Error('任务仍在运行，请等待完成或先停止');
        if (typeof c.text !== 'string' || !c.text.trim() || c.text.length > 100000) throw new Error('消息须包含 1–100000 个字符');
        event(s, 'user', { text: c.text }); event(s, 'status', { status: 'running' });
        try { await s.agent.prompt(c.text); }
        catch (e) { if (!s.deleted) { event(s, 'error', { text: e.message }); event(s, 'status', { status: 'error' }); } throw e; }
        return {};
      }
      if (c.type === 'model') {
        if (['running', 'waiting'].includes(s.status)) throw new Error('任务运行中不能切换模型，请先停止或等待完成');
        if (!s.models.some(m => m.id === c.model)) throw new Error('所选模型不在该 agent 的可用列表中');
        await s.agent.model(c.model); s.model = c.model; save(); event(s, 'model', { model: s.model }); return summary(s);
      }
      throw new Error('Unknown command');
    } finally { s.busy = false; }
  }
  const heartbeat = setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }, 25000); heartbeat.unref();
  return { server, sessions, token, handle, async close() { clearInterval(heartbeat); await Promise.all([...sessions.values()].map(s => s.agent?.close())); for (const ws of wss.clients) ws.terminate(); await new Promise(r => wss.close(r)); await new Promise(r => server.close(r)); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.env.AGENT_ROOT || process.cwd());
  const port = Number(process.env.PORT || 8787), host = process.env.HOST || '0.0.0.0';
  const advertisedUrl = process.env.LAN_URL;
  const dataDir = resolve(process.env.DATA_DIR || resolve(root, '.lan-agent'));
  const configuredCode = process.env.PAIR_CODE || process.env.PAIR_TOKEN;
  if (!configuredCode && !existsSync(resolve(dataDir, 'token'))) throw new Error('请先运行 scripts/set-pairing-code.sh 设置自定义配对码，或私下配置 PAIR_CODE 环境变量');
  const bridge = createBridge({ root, dataDir, token: configuredCode, advertisedUrl });
  bridge.server.listen(port, host, async () => {
    const url = advertisedUrl || linuxLanUrl(bridge.server.address().port);
    console.log(`\nLAN Agent ${VERSION} · Linux Web\n项目根目录: ${root}\n本机网页: http://localhost:${bridge.server.address().port}\n电脑/手机网址: ${url}\n登录时输入管理员设置的自定义配对码（不会在日志中显示）。\n下面二维码打开手机网页；登录仍需要配对码。仅在可信局域网使用。`);
    console.log(await QRCode.toString(`${url}/`, { type: 'terminal', small: true }));
  });
  serverErrors(bridge.server);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await bridge.close(); process.exit(0); });
}
function serverErrors(server) {
  server.on('error', e => { console.error(`Linux Web 服务启动失败：${e.message}`); process.exitCode = 1; });
}
