import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge } from '../src/server.js';

async function setup(t, factory) {
  const root = mkdtempSync(join(tmpdir(), 'linux-web-test-'));
  const b = createBridge({ root, quiet: true, agentFactory: factory });
  await new Promise(r => b.server.listen(0, '0.0.0.0', r));
  t.after(async () => { await b.close(); rmSync(root, { recursive: true, force: true }); });
  return { b, root };
}
function factory(kind, cwd, emit) {
  return { closed: false, async init() { return { model: 'model-a', models: [{ id: 'model-a', name: 'A' }, { id: 'model-b', name: 'B' }] }; }, async prompt() { emit('delta', { channel: 'assistant', key: 'answer', text: 'hello' }); emit('completed', { status: 'completed' }); }, async model(id) { this.selected = id; }, async abort() { emit('completed', { status: 'cancelled' }); }, close() { this.closed = true; } };
}
test('delete closes process, removes bridge history, persists removal, rejects subsequent access', async t => {
  let emit, child;
  const { b, root } = await setup(t, (kind, cwd, e) => { emit = e; child = factory(kind, cwd, e); return child; });
  const s = await b.handle({ type: 'create', agent: 'pi', title: '测试会话' });
  await b.handle({ type: 'prompt', sessionId: s.id, text: 'hi' });
  const file = join(root, '.lan-agent', `${s.id}.jsonl`); assert.ok(existsSync(file));
  const deleted = await b.handle({ type: 'delete', sessionId: s.id });
  assert.equal(deleted.deleted, true); assert.equal(child.closed, true); assert.equal(existsSync(file), false);
  assert.equal(b.sessions.has(s.id), false); assert.deepEqual(JSON.parse(readFileSync(join(root, '.lan-agent', 'sessions.json'))), []);
  emit('delta', { channel: 'assistant', text: 'late output' }); assert.equal(existsSync(file), false);
  await assert.rejects(b.handle({ type: 'subscribe', sessionId: s.id }), /不存在/);
});
test('delete is allowed during an unresolved prompt and late failure does not resurrect session', async t => {
  let release;
  const { b, root } = await setup(t, (kind, cwd, emit) => ({ ...factory(kind, cwd, emit), prompt() { return new Promise(r => release = r); }, close() { this.closed = true; release?.(); } }));
  const s = await b.handle({ type: 'create', agent: 'codex' });
  const prompt = b.handle({ type: 'prompt', sessionId: s.id, text: 'run' });
  assert.equal(b.sessions.get(s.id).busy, true);
  await b.handle({ type: 'delete', sessionId: s.id }); await prompt;
  assert.equal(b.sessions.size, 0); assert.equal(existsSync(join(root, '.lan-agent', `${s.id}.jsonl`)), false);
});
test('delete during agent initialization cannot recreate metadata/history', async t => {
  let finish;
  const { b, root } = await setup(t, (kind, cwd, emit) => ({ ...factory(kind, cwd, emit), init() { return new Promise(resolve => finish = resolve); } }));
  const creating = b.handle({ type: 'create', agent: 'pi' });
  const rejection = assert.rejects(creating, /已被删除/);
  const id = [...b.sessions.keys()][0]; await b.handle({ type: 'delete', sessionId: id });
  finish({ model: 'a', models: [] }); await rejection;
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.lan-agent', 'sessions.json'))), []);
  assert.equal(existsSync(join(root, '.lan-agent', `${id}.jsonl`)), false);
});
test('rename, close, delete offline and fresh restart maintain correct state', async t => {
  const { b, root } = await setup(t, factory);
  const s = await b.handle({ type: 'create', agent: 'pi' });
  assert.equal((await b.handle({ type: 'rename', sessionId: s.id, title: '新的名称' })).title, '新的名称');
  await assert.rejects(b.handle({ type: 'rename', sessionId: s.id, title: ' ' }), /1–120/);
  const offline = await b.handle({ type: 'close', sessionId: s.id }); assert.equal(offline.ready, false);
  await b.handle({ type: 'delete', sessionId: s.id });
  const restart = createBridge({ root, quiet: true, agentFactory: factory });
  await new Promise(r => restart.server.listen(0, r)); assert.equal(restart.sessions.size, 0); await restart.close();
});
test('working directory rejects files, missing folders and out-of-root symlinks', async t => {
  const { b, root } = await setup(t, factory); writeFileSync(join(root, 'file'), 'test');
  await assert.rejects(b.handle({ type: 'create', agent: 'pi', cwd: 'file' }), /文件夹/);
  await assert.rejects(b.handle({ type: 'create', agent: 'pi', cwd: 'missing' }), /不存在/);
  await assert.rejects(b.handle({ type: 'create', agent: 'pi', cwd: '..' }), /inside bridge root/);
  assert.equal(b.sessions.size, 0);
});
test('phone browser QR uses browser URL and preserves legacy Android JSON pairing', async t => {
  const { b } = await setup(t, factory);
  const data = await b.handle({ type: 'pair' }, { origin: 'http://192.0.2.42:8787' });
  assert.equal(data.url, 'http://192.0.2.42:8787'); assert.equal(new URL(data.browserUrl).hash, `#token=${b.token}`);
  assert.ok(data.webQr.startsWith('data:image/png')); assert.equal(JSON.parse(data.payload).token, b.token);
  assert.equal(JSON.parse(data.payload).version, 1);
});
