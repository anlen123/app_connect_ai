import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createBridge } from '../src/server.js';
import { PiAgent, CodexAgent, jsonLines } from '../src/agents.js';
import { PassThrough } from 'node:stream';

const wait = ms => new Promise(r => setTimeout(r, ms));
function mock(kind, cwd, emit) {
  return { closed: false, async init() { return { model: 'p/m1', models: [{ id: 'p/m1', name: 'M1' }, { id: 'p/m2', name: 'M2' }] }; }, async prompt(text) { emit('delta', { channel: 'thinking', key: 't', text: '思考' }); emit('delta', { channel: 'assistant', key: 'a', text: `收到${text}` }); emit('tool', { key: 'x', name: 'read', status: 'start' }); emit('choice', { requestId: 'q', kind: 'select', options: ['A', 'B'], title: '选择' }); }, async model(id) { this.selected = id; }, async answer(id, answer) { assert.equal(id, 'q'); assert.equal(answer.value, 'A'); emit('completed', { status: 'completed' }); }, async abort() { emit('completed', { status: 'cancelled' }); }, close() { this.closed = true; } };
}
async function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'lan-test-'));
  const bridge = createBridge({ root, quiet: true, agentFactory: mock });
  await new Promise(r => bridge.server.listen(0, '127.0.0.1', r));
  t.after(async () => { await bridge.close(); rmSync(root, { recursive: true, force: true }); });
  return bridge;
}
test('authenticated websocket: sessions, thinking, model, choice, completion, replay', async t => {
  const b = await setup(t), ws = new WebSocket(`ws://127.0.0.1:${b.server.address().port}/ws`);
  const messages = []; ws.on('message', raw => messages.push(JSON.parse(raw)));
  await new Promise(r => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'auth', token: b.token }));
  while (!messages.some(m => m.type === 'hello')) await wait(5);
  let n = 0;
  async function call(type, extra = {}) { const id = String(++n); ws.send(JSON.stringify({ type, id, ...extra })); for (let i = 0; i < 500; i++) { const m = messages.find(m => m.id === id); if (m) return m; await wait(5); } throw new Error('test timeout'); }
  const created = await call('create', { agent: 'pi', cwd: '.' }); assert.equal(created.ok, true); const sessionId = created.data.id;
  assert.equal((await call('model', { sessionId, model: 'p/m2' })).data.model, 'p/m2');
  assert.equal((await call('prompt', { sessionId, text: '你好' })).ok, true);
  assert.ok(messages.some(m => m.channel === 'thinking' && m.text === '思考'));
  assert.equal((await call('subscribe', { sessionId })).data.choices.length, 1);
  assert.equal((await call('prompt', { sessionId, text: '冲突' })).ok, false);
  assert.equal((await call('answer', { sessionId, requestId: 'q', answer: { value: 'A' } })).ok, true);
  assert.equal((await call('answer', { sessionId, requestId: 'q', answer: { value: 'A' } })).ok, false);
  const snapshot = (await call('subscribe', { sessionId })).data;
  assert.equal(snapshot.status, 'completed'); assert.equal(snapshot.tools, 1); assert.equal(snapshot.turns, 1); assert.equal(snapshot.choices.length, 0);
  assert.ok(snapshot.events.some(e => e.event === 'completed'));
  assert.equal((await call('create', { agent: 'codex', cwd: '..' })).ok, false);
  assert.equal((await call('model', { sessionId, model: 'unknown' })).ok, false);
  const pair = await call('pair'); assert.equal(JSON.parse(pair.data.payload).token, b.token); assert.ok(pair.data.qr.startsWith('data:image/png'));
  ws.close();
});
test('bad token and hostile browser origin rejected', async t => {
  const b = await setup(t);
  for (const origin of [undefined, 'https://evil.example']) {
    const ws = new WebSocket(`ws://127.0.0.1:${b.server.address().port}/ws`, origin ? { origin } : {});
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: 'bad' })));
    const code = await new Promise(r => ws.on('close', r)); assert.equal(code, 1008);
  }
});
test('restart replays stored history, never pretends child process is alive', async t => {
  const root = mkdtempSync(join(tmpdir(), 'lan-restart-')); let b = createBridge({ root, quiet: true, agentFactory: mock });
  await new Promise(r => b.server.listen(0, r)); const s = await b.handle({ type: 'create', agent: 'codex' }); await b.handle({ type: 'prompt', sessionId: s.id, text: 'hello' }); const token = b.token; await b.close();
  b = createBridge({ root, quiet: true, agentFactory: mock }); await new Promise(r => b.server.listen(0, r));
  t.after(async () => { await b.close(); rmSync(root, { recursive: true, force: true }); });
  assert.equal(b.token, token); const replay = await b.handle({ type: 'subscribe', sessionId: s.id }); assert.equal(replay.status, 'offline'); assert.ok(replay.events.some(e => e.channel === 'thinking'));
});
test('JSONL handles fragmented UTF8, CRLF and Unicode separators', () => {
  const stream = new PassThrough(), records = []; jsonLines(stream, r => records.push(r), e => { throw e; });
  const bytes = Buffer.from(JSON.stringify({ text: '你\u2028好\u2029!' }) + '\r\n');
  for (const byte of bytes) stream.write(Buffer.from([byte])); assert.deepEqual(records, [{ text: '你\u2028好\u2029!' }]);
});
test('pi normalization waits for settled, replaces authoritative content, exposes all dialogs', () => {
  const records = [], a = Object.create(PiAgent.prototype); a.emit = (type, data) => records.push({ type, ...data }); a.message = 0; a.ui = new Map();
  a.receive({ type: 'message_start', message: { role: 'assistant' } });
  a.receive({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: '思' } });
  a.receive({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '完整思考' }, { type: 'text', text: '回答' }], stopReason: 'stop' } });
  a.receive({ type: 'tool_execution_update', toolCallId: 'tool', toolName: 'bash', args: { command: 'echo partial' }, partialResult: { content: [{ type: 'text', text: 'partial' }] } });
  assert.equal(records.at(-1).detail.content[0].text, 'partial');
  a.receive({ type: 'agent_end' }); assert.ok(!records.some(r => r.type === 'completed'));
  a.receive({ type: 'extension_ui_request', id: 'r', method: 'confirm', title: '确认' }); assert.equal(a.ui.size, 1);
  a.receive({ type: 'agent_settled' }); assert.ok(records.some(r => r.type === 'completed')); assert.ok(records.some(r => r.type === 'content' && r.text === '完整思考')); assert.equal(a.ui.size, 0);
});
test('codex normalization: reasoning, task plan, approvals, questions, errors', async () => {
  const records = [], writes = [], a = Object.create(CodexAgent.prototype); a.emit = (type, data) => records.push({ type, ...data }); a.ui = new Map(); a.write = r => writes.push(r);
  a.receive({ method: 'item/reasoning/summaryTextDelta', params: { itemId: 'x', summaryIndex: 0, delta: '分析' } });
  a.receive({ method: 'turn/plan/updated', params: { plan: [{ step: '实现', status: 'inProgress' }] } });
  a.receive({ id: 4, method: 'item/commandExecution/requestApproval', params: { command: 'echo ok' } });
  await a.answer('4', { value: 'accept' }); assert.deepEqual(writes[0], { id: 4, result: { decision: 'accept' } });
  a.receive({ id: 5, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'q', question: '?' }] } });
  await a.answer('5', { answers: { q: ['A'] } }); assert.deepEqual(writes[1].result, { answers: { q: { answers: ['A'] } } });
  a.receive({ method: 'turn/completed', params: { turn: { status: 'failed', error: { message: 'fail' } } } });
  assert.ok(records.some(r => r.channel === 'thinking')); assert.ok(records.some(r => r.type === 'plan')); assert.equal(records.at(-1).status, 'error');
});
