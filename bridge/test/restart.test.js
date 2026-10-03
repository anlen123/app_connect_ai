import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge } from '../src/server.js';
import { recoverNative } from '../src/session-recovery.js';
import { CodexAgent } from '../src/agents.js';

const info = { model: 'a', models: [{ id: 'a' }, { id: 'b' }] };
async function setup(t, factory) {
  const root = mkdtempSync(join(tmpdir(), 'lan-restart-'));
  const bridges = [];
  const open = async () => { const bridge = createBridge({ root, quiet: true, agentFactory: factory }); await new Promise(r => bridge.server.listen(0, r)); bridges.push(bridge); return bridge; };
  t.after(async () => { for (const b of bridges) await b.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, open, b: await open() };
}
test('startup progress is absent, restart retains native reference/model/history across bridge reload', async t => {
  const optionsSeen = [], emitters = [];
  const { b, root, open } = await setup(t, (_kind, _cwd, emit, options) => {
    optionsSeen.push(options); emitters.push(emit);
    return { closed: false, async init() { emit('progress', { text: 'startup widget' }); emit('plan', { steps: [] }); return { ...info, native: options.native || { threadId: 'original-thread' } }; }, async model(id) { this.selected = id; }, async prompt() { emit('progress', { text: 'real task' }); emit('content', { channel: 'thinking', key: 'empty', text: '' }); emit('delta', { channel: 'thinking', key: 'empty' }); emit('completed', { status: 'completed' }); }, close() { this.closed = true; } };
  });
  const session = await b.handle({ type: 'create', agent: 'codex' });
  assert.equal(session.events.filter(e => ['progress', 'plan'].includes(e.event)).length, 0);
  await b.handle({ type: 'model', sessionId: session.id, model: 'b' });
  await b.handle({ type: 'prompt', sessionId: session.id, text: 'remember this' });
  assert.equal(b.sessions.get(session.id).events.filter(e => e.channel === 'thinking').length, 0);
  await b.handle({ type: 'close', sessionId: session.id });
  const restarted = await b.handle({ type: 'restart', sessionId: session.id });
  assert.equal(restarted.id, session.id); assert.equal(restarted.model, 'b'); assert.equal(restarted.ready, true);
  assert.equal(restarted.events.filter(e => e.event === 'user').length, 1);
  assert.deepEqual(optionsSeen[1].native, { threadId: 'original-thread' });
  emitters[0]('error', { text: 'late old process', fatal: true }); assert.equal(b.sessions.get(session.id).status, 'idle');
  const metadata = JSON.parse(readFileSync(join(root, '.lan-agent/sessions.json')));
  assert.deepEqual(metadata[0].native, { threadId: 'original-thread' });
  const reloaded = await open();
  const recovered = await reloaded.handle({ type: 'restart', sessionId: session.id });
  assert.equal(recovered.ready, true); assert.equal(recovered.model, 'b'); assert.deepEqual(optionsSeen[2].native, { threadId: 'original-thread' });
});
test('duplicate restart, live restart and delete during restart are safe', async t => {
  let finish, calls = 0;
  const { b, root } = await setup(t, () => ({ closed: false, async init() { calls++; if (calls > 1) return new Promise(r => finish = r); return info; }, close() { this.closed = true; } }));
  const s = await b.handle({ type: 'create', agent: 'pi' });
  await assert.rejects(b.handle({ type: 'restart', sessionId: s.id }), /仍在运行/);
  await b.handle({ type: 'close', sessionId: s.id });
  const restarting = b.handle({ type: 'restart', sessionId: s.id });
  const rejected = assert.rejects(restarting, /已被删除/);
  await assert.rejects(b.handle({ type: 'restart', sessionId: s.id }), /正在处理/);
  await b.handle({ type: 'delete', sessionId: s.id }); finish(info); await rejected;
  assert.equal(b.sessions.size, 0); assert.deepEqual(JSON.parse(readFileSync(join(root, '.lan-agent/sessions.json'))), []);
});
test('legacy recovery uses unique evidence and never silently loses context', t => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-session-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const timestamp = Date.now(), events = [{ event: 'user', text: 'unique history', timestamp }];
  const s = { kind: 'pi', cwd: root, events };
  assert.throws(() => recoverNative(s, root), /安全重启/);
  assert.throws(() => recoverNative({ ...s, native: { sessionFile: join(root, 'missing') } }), /不存在/);
  const native = [{ type: 'session', id: 'original', cwd: root }, { type: 'session_info', name: 'LAN Agent' }, { type: 'message', message: { role: 'user', content: 'unique history', timestamp } }];
  writeFileSync(join(root, 'original.jsonl'), native.map(e => JSON.stringify(e)).join('\n'));
  assert.equal(recoverNative(s, root).sessionId, 'original');
  writeFileSync(join(root, 'ambiguous.jsonl'), native.map(e => JSON.stringify(e)).join('\n'));
  assert.throws(() => recoverNative(s, root), /安全重启/);
  assert.deepEqual(recoverNative({ kind: 'codex', events: [...events, { event: 'progress', detail: { threadId: 'original-thread' } }] }), { threadId: 'original-thread' });
});
test('Codex resumes the original native thread and explicitly requests supported public summaries', async () => {
  const calls = [], model = { model: 'real-model', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }], defaultReasoningEffort: 'low' };
  const agent = { native: { threadId: 'original-thread' }, cwd: '/tmp', write() {}, async rpc(method, params) {
    calls.push({ method, params });
    if (method === 'model/list') return { data: [model], nextCursor: null };
    if (method === 'thread/resume') return { thread: { id: params.threadId }, model: 'real-model' };
    if (method === 'turn/start') return { turn: { id: 'new-turn' } };
    return {};
  } };
  const state = await CodexAgent.prototype.init.call(agent);
  assert.deepEqual(state.native, agent.native); assert.equal(calls.some(c => c.method === 'thread/start'), false);
  await CodexAgent.prototype.prompt.call(agent, 'hello');
  const turn = calls.at(-1); assert.equal(turn.params.threadId, 'original-thread'); assert.equal(turn.params.summary, 'detailed'); assert.equal(turn.params.effort, 'medium');
});
