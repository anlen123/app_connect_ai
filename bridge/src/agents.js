import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { VERSION } from './version.js';

// Split strictly on LF, not Unicode line separators. Both agents use JSONL.
export function jsonLines(stream, callback, onError) {
  const decoder = new StringDecoder('utf8'); let buffer = '';
  stream.on('data', chunk => {
    buffer += decoder.write(chunk);
    if (buffer.length > 32 * 1024 * 1024) { onError(new Error('Agent record exceeds 32 MiB')); stream.destroy(); return; }
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).replace(/\r$/, ''); buffer = buffer.slice(i + 1);
      if (!line.trim()) continue;
      try { callback(JSON.parse(line)); } catch (e) { onError(e); }
    }
  });
}

class ProcessAgent {
  constructor(command, args, cwd, emit) {
    this.emit = emit; this.pending = new Map(); this.closed = false;
    this.child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    this.child.stdin.on('error', e => this.fail(e));
    jsonLines(this.child.stdout, r => { if (!this.closed) this.receive(r); }, e => { if (!this.closed) this.emit('diagnostic', { text: e.message }); });
    this.child.stderr.on('data', b => { if (!this.closed) this.emit('diagnostic', { text: b.toString().slice(0, 8000) }); });
    this.child.on('error', e => this.fail(e));
    this.child.on('exit', (code, signal) => this.fail(new Error(`Agent exited (${code ?? signal})`)));
  }
  write(record) {
    if (this.closed) throw new Error('Agent is closed');
    this.child.stdin.write(JSON.stringify(record) + '\n');
  }
  request(record, timeoutMs = 45000) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => { this.pending.delete(id); reject(new Error('Agent command timed out')); }, timeoutMs) : null;
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ ...record, id }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  resolve(r, error, data) {
    const p = this.pending.get(r.id); if (!p) return false;
    clearTimeout(p.timer); this.pending.delete(r.id);
    if (error) p.reject(new Error(typeof error === 'string' ? error : JSON.stringify(error))); else p.resolve(data);
    return true;
  }
  fail(e) {
    if (this.closed) return; this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e); }
    this.pending.clear(); this.emit('error', { text: e.message, fatal: true });
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Session closed')); }
    this.pending.clear();
    if (!this.child.pid || this.child.exitCode !== null || this.child.signalCode !== null) return Promise.resolve();
    this.closePromise = new Promise(resolve => {
      const terminate = setTimeout(() => this.child.kill('SIGTERM'), 2000);
      const kill = setTimeout(() => this.child.kill('SIGKILL'), 5000);
      terminate.unref(); kill.unref();
      this.child.once('exit', () => { clearTimeout(terminate); clearTimeout(kill); resolve(); });
      this.child.stdin.end();
    });
    return this.closePromise;
  }
}

export class PiAgent extends ProcessAgent {
  constructor(cwd, emit, options = {}) {
    super(options.command || process.env.PI_BIN || 'pi', options.args || ['--mode', 'rpc', '--name', 'LAN Agent', '--extension', fileURLToPath(new URL('./mobile-ui.ts', import.meta.url)), '--append-system-prompt', 'You are controlled from the LAN Agent Android/desktop client. When you need a user choice, clarification, or authorization, use lan_ask_user; custom terminal-only UI does not work here.'], cwd, emit);
    this.message = 0; this.ui = new Map(); this.failed = false; this.aborted = false;
  }
  async init() {
    const [state, list] = await Promise.all([this.request({ type: 'get_state' }), this.request({ type: 'get_available_models' })]);
    await this.enableThinking();
    return { model: state.model ? `${state.model.provider}/${state.model.id}` : '', models: list.models.map(m => ({ id: `${m.provider}/${m.id}`, name: `${m.name} · ${m.provider}` })) };
  }
  async enableThinking() {
    const available = await this.request({ type: 'get_available_thinking_levels' });
    if (available.levels.includes('medium')) await this.request({ type: 'set_thinking_level', level: 'medium' });
  }
  async prompt(text) {
    this.failed = false; this.aborted = false;
    const result = await this.request({ type: 'prompt', message: text }, 0);
    if (result?.disposition === 'handled' && !this.running) this.emit('completed', { status: 'completed', handled: true });
  }
  async model(id) { const i = id.indexOf('/'); if (i < 1) throw new Error('Invalid pi model'); await this.request({ type: 'set_model', provider: id.slice(0, i), modelId: id.slice(i + 1) }); await this.enableThinking(); }
  async abort() { this.aborted = true; await this.request({ type: 'clear_queue' }); await this.request({ type: 'abort' }); }
  async answer(id, answer) {
    const r = this.ui.get(id); if (!r) throw new Error('Request expired or already answered');
    let response = { type: 'extension_ui_response', id };
    if (answer.cancelled) response.cancelled = true;
    else if (r.method === 'confirm') response.confirmed = answer.value === true || answer.value === 'true';
    else { if (r.method === 'select' && !r.options.includes(answer.value)) throw new Error('Invalid choice'); response.value = String(answer.value ?? ''); }
    this.write(response); this.ui.delete(id);
  }
  receive(r) {
    if (r.type === 'response') { this.resolve(r, r.success ? null : r.error, r.data); return; }
    if (r.type === 'message_start' && r.message?.role === 'assistant') this.message++;
    if (r.type === 'agent_start') { this.running = true; this.emit('status', { status: 'running' }); }
    if (r.type === 'message_update') {
      const e = r.assistantMessageEvent;
      if (['text_delta', 'thinking_delta'].includes(e?.type)) this.emit('delta', { channel: e.type === 'thinking_delta' ? 'thinking' : 'assistant', key: `pi-${this.message}-${e.contentIndex}`, text: e.delta });
      if (['text_end', 'thinking_end'].includes(e?.type)) this.emit('content', { channel: e.type === 'thinking_end' ? 'thinking' : 'assistant', key: `pi-${this.message}-${e.contentIndex}`, text: e.content });
    }
    if (r.type === 'message_end' && r.message?.role === 'assistant') {
      r.message.content?.forEach((b, i) => { if (b.type === 'text' || b.type === 'thinking') this.emit('content', { channel: b.type === 'text' ? 'assistant' : 'thinking', key: `pi-${this.message}-${i}`, text: b.text ?? b.thinking ?? (b.redacted ? '[提供方隐藏了思考内容]' : '') }); });
      if (['error', 'aborted'].includes(r.message.stopReason)) { this.failed = r.message.stopReason === 'error'; this.aborted = r.message.stopReason === 'aborted'; this.emit('error', { text: r.message.errorMessage || r.message.stopReason }); }
      else if (r.message.stopReason !== 'pending') this.failed = false; // A successful retry supersedes the transient provider failure.
    }
    if (r.type?.startsWith('tool_execution_')) {
      let detail = r.result;
      if (r.type === 'tool_execution_start') detail = r.args;
      else if (r.type === 'tool_execution_update') detail = r.partialResult;
      this.emit('tool', { key: r.toolCallId, name: r.toolName, status: r.type.split('_').at(-1), detail, isError: r.isError });
    }
    if (r.type === 'agent_settled') { this.running = false; this.clearUI(); this.emit('completed', { status: this.failed ? 'error' : this.aborted ? 'cancelled' : 'completed' }); }
    if (r.type === 'extension_ui_request') {
      if (['select', 'confirm', 'input', 'editor'].includes(r.method)) {
        this.ui.set(r.id, r); this.emit('choice', { requestId: r.id, kind: r.method, title: r.title, message: r.message, options: r.options, prefill: r.prefill, timeout: r.timeout });
        if (r.timeout) { const t = setTimeout(() => { if (this.ui.delete(r.id)) this.emit('choice_closed', { requestId: r.id }); }, r.timeout); t.unref(); }
      } else if (r.method === 'setStatus' || r.method === 'setWidget') this.emit('progress', { text: r.statusText ?? r.widgetLines?.join('\n') ?? '', key: r.statusKey ?? r.widgetKey });
      else if (r.method === 'notify') this.emit('notice', { text: r.message, level: r.notifyType });
    }
    if (['auto_retry_start', 'compaction_start', 'compaction_end', 'turn_start', 'turn_end'].includes(r.type)) this.emit('progress', { text: r.type, detail: r });
  }
  clearUI() { for (const id of this.ui.keys()) this.emit('choice_closed', { requestId: id }); this.ui.clear(); }
}

export class CodexAgent extends ProcessAgent {
  constructor(cwd, emit, options = {}) {
    super(options.command || process.env.CODEX_BIN || 'codex', options.args || ['app-server', '--listen', 'stdio://'], cwd, emit);
    this.cwd = cwd; this.ui = new Map(); this.thread = null; this.turn = null; this.selected = null;
  }
  rpc(method, params = {}) { return this.request({ method, params }); }
  async init() {
    await this.rpc('initialize', { clientInfo: { name: 'lan_agent', title: 'LAN Agent', version: VERSION }, capabilities: { experimentalApi: true } });
    this.write({ method: 'initialized', params: {} });
    let models = [], cursor = null;
    do { const page = await this.rpc('model/list', { cursor, limit: 100 }); models.push(...page.data); cursor = page.nextCursor; } while (cursor);
    const result = await this.rpc('thread/start', { cwd: this.cwd, approvalPolicy: 'on-request', sandbox: 'workspace-write' });
    this.thread = result.thread.id; this.selected = result.model;
    return { model: this.selected, models: models.map(m => ({ id: m.model, name: m.displayName || m.model })) };
  }
  async prompt(text) {
    const r = await this.rpc('turn/start', { threadId: this.thread, model: this.selected, summary: 'auto', input: [{ type: 'text', text, text_elements: [] }] });
    this.turn = r.turn.id;
  }
  async model(id) { this.selected = id; }
  async abort() { if (this.turn) await this.rpc('turn/interrupt', { threadId: this.thread, turnId: this.turn }); }
  async answer(id, answer) {
    const r = this.ui.get(id); if (!r) throw new Error('Request expired or already answered');
    let result;
    if (r.method.endsWith('/requestApproval') && r.method.includes('permissions')) result = { permissions: {}, scope: 'turn' }; // Never grant broad permissions implicitly.
    else if (r.method.endsWith('/requestApproval')) {
      const decision = answer.cancelled ? 'cancel' : answer.value;
      if (!['accept', 'acceptForSession', 'decline', 'cancel'].includes(decision)) throw new Error('Invalid approval decision');
      result = { decision };
    } else if (r.method === 'item/tool/requestUserInput') {
      const answers = {};
      for (const q of r.params.questions) { const value = answer.answers?.[q.id]; if (!Array.isArray(value) || !value.length) throw new Error(`Missing answer: ${q.id}`); answers[q.id] = { answers: value.map(String) }; }
      result = { answers };
    } else if (r.method === 'mcpServer/elicitation/request') result = answer.cancelled ? { action: 'cancel', content: null } : { action: 'accept', content: answer.content };
    else throw new Error('Unsupported agent interaction');
    this.write({ id: r.id, result }); this.ui.delete(id);
  }
  receive(r) {
    if ('result' in r || 'error' in r) { this.resolve(r, r.error, r.result); return; }
    if ('id' in r && r.method) {
      if (r.method.endsWith('/requestApproval') || r.method === 'item/tool/requestUserInput' || r.method === 'mcpServer/elicitation/request') {
        const id = String(r.id); this.ui.set(id, r);
        this.emit('choice', { requestId: id, kind: r.method === 'item/tool/requestUserInput' ? 'questions' : r.method === 'mcpServer/elicitation/request' ? 'elicitation' : 'approval', title: r.method, message: JSON.stringify(r.params, null, 2), questions: r.params.questions, schema: r.params.requestedSchema, options: r.method.includes('permissions') ? ['decline'] : ['accept', 'decline', 'cancel'] });
      } else { this.write({ id: r.id, error: { code: -32601, message: 'Unsupported request in LAN client' } }); this.emit('error', { text: `Unsupported server request: ${r.method}` }); }
      return;
    }
    const p = r.params || {}, method = r.method || '';
    if (method === 'turn/started') { this.turn = p.turn.id; this.emit('status', { status: 'running' }); }
    if (method === 'item/agentMessage/delta' || method.includes('reasoning/') && method.endsWith('Delta')) this.emit('delta', { channel: method.includes('reasoning/') ? 'thinking' : 'assistant', key: `${p.itemId}-${p.summaryIndex ?? p.contentIndex ?? 0}-${method.includes('textDelta') ? 'raw' : 'summary'}`, text: p.delta });
    if (method === 'item/started' || method === 'item/completed') {
      const item = p.item;
      if (item.type === 'agentMessage' && method === 'item/completed') this.emit('content', { channel: 'assistant', key: `${item.id}-0-summary`, text: item.text });
      else if (item.type === 'reasoning' && method === 'item/completed') {
        (item.summary || []).forEach((text, i) => this.emit('content', { channel: 'thinking', key: `${item.id}-${i}-summary`, text }));
        (item.content || []).forEach((text, i) => this.emit('content', { channel: 'thinking', key: `${item.id}-${i}-raw`, text }));
      } else if (!['agentMessage', 'reasoning', 'userMessage'].includes(item.type)) this.emit('tool', { key: item.id, name: item.type, status: method === 'item/started' ? 'start' : 'end', detail: item });
    }
    if (method === 'item/commandExecution/outputDelta') this.emit('tool_output', { key: p.itemId, text: p.delta });
    if (method === 'turn/plan/updated') this.emit('plan', { explanation: p.explanation, steps: p.plan });
    if (method === 'turn/completed') {
      this.turn = null; for (const id of this.ui.keys()) this.emit('choice_closed', { requestId: id }); this.ui.clear();
      this.emit('completed', { status: p.turn.status === 'completed' ? 'completed' : p.turn.status === 'interrupted' ? 'cancelled' : 'error', error: p.turn.error });
    }
    if (method === 'error') this.emit('error', { text: p.error?.message || JSON.stringify(p), fatal: false });
    if (['thread/tokenUsage/updated', 'turn/diff/updated', 'item/mcpToolCall/progress'].includes(method)) this.emit('progress', { text: method, detail: p });
  }
}
