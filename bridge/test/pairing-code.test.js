import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { validatePairingCode, savePairingCode } from '../src/pairing-code.js';
import { createBridge } from '../src/server.js';

async function fixture(t, token = 'MyPrivateCode_12') {
  const root = mkdtempSync(join(tmpdir(), 'pairing-test-')), dataDir = join(root, 'private');
  savePairingCode(dataDir, token);
  const bridge = createBridge({ root, dataDir, quiet: true }); await new Promise(r => bridge.server.listen(0, '127.0.0.1', r));
  t.after(async () => { await bridge.close(); rmSync(root, { recursive: true, force: true }); });
  return { bridge, root, dataDir, url: `ws://127.0.0.1:${bridge.server.address().port}/ws` };
}
function login(url, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url); ws.on('error', reject);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
    ws.on('message', b => { const r = JSON.parse(b); if (r.type === 'hello') { ws.close(); resolve({ ok: true }); } });
    ws.on('close', (code, reason) => { if (code === 1008) resolve({ ok: false, reason: String(reason) }); });
  });
}
test('administrator custom code validation, atomic private persistence and rotation', async t => {
  for (const value of ['tiny', 'x'.repeat(257), '12345678901\nMORE']) assert.throws(() => validatePairingCode(value));
  assert.equal(validatePairingCode('  MyPrivateCode_12  '), 'MyPrivateCode_12');
  assert.equal(validatePairingCode('这是一个十二字以上的安全配对短语'), '这是一个十二字以上的安全配对短语');
  const { bridge, url, dataDir } = await fixture(t);
  assert.equal(statSync(join(dataDir, 'token')).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(dataDir, 'token'), 'utf8').trim(), bridge.token);
  assert.deepEqual(await login(url, 'MyPrivateCode_12'), { ok: true });
  assert.equal((await login(url, 'WrongPrivate_12')).ok, false);
  savePairingCode(dataDir, 'RotatedPrivate_42');
  // A running bridge keeps its current credential; applying changes needs an explicit restart.
  assert.deepEqual(await login(url, 'MyPrivateCode_12'), { ok: true });
  const other = createBridge({ root: dataDir, dataDir, quiet: true }); await new Promise(r => other.server.listen(0, '127.0.0.1', r)); t.after(() => other.close());
  const otherUrl = `ws://127.0.0.1:${other.server.address().port}/ws`;
  assert.equal((await login(otherUrl, 'MyPrivateCode_12')).ok, false);
  assert.equal((await login(otherUrl, 'RotatedPrivate_42')).ok, true);
});
test('repeated guessing is rate-limited, including on new WebSocket connections', async t => {
  const { url } = await fixture(t);
  for (let i = 0; i < 5; i++) assert.equal((await login(url, 'WrongPrivate_12')).ok, false);
  assert.match((await login(url, 'MyPrivateCode_12')).reason, /Too many login attempts/);
});
test('default website pairing can omit credentials, legacy opt-in remains compatible', async t => {
  const { bridge } = await fixture(t);
  const manual = await bridge.handle({ type: 'pair', includeCredentials: false });
  assert.equal(new URL(manual.browserUrl).hash, ''); assert.ok(!manual.browserUrl.includes(bridge.token));
  const auto = await bridge.handle({ type: 'pair', includeCredentials: true });
  assert.equal(new URLSearchParams(new URL(auto.browserUrl).hash.slice(1)).get('token'), bridge.token);
  assert.equal(JSON.parse(auto.payload).token, bridge.token);
});
