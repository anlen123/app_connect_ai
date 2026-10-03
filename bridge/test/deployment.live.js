// Read-only real inference against an already-running Linux deployment.
// Deletes only the new uniquely named test sessions, never pre-existing user sessions.
import assert from 'node:assert/strict';
import { chromium, devices } from 'playwright';
import { expect } from '@playwright/test';
import { WebSocket } from 'ws';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { linuxLanUrl } from '../src/server.js';
import { VERSION } from '../src/version.js';
import { menuClick } from './browser-actions.js';
const url = process.env.LIVE_URL || linuxLanUrl(8787);
const token = readFileSync(process.env.LIVE_TOKEN_PATH || join(homedir(), '.local/share/lan-agent/token'), 'utf8').trim();
const ws = new WebSocket(`${url.replace(/^http/, 'ws')}/ws`), pending = new Map();
let counter = 0;
const initial = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Deployment auth timeout')), 10000);
  ws.on('error', reject); ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
  ws.on('message', raw => { const r = JSON.parse(raw); if (r.type === 'hello') { clearTimeout(timer); resolve(r); } if (r.type === 'response') { const p = pending.get(r.id); if (p) { pending.delete(r.id); if (r.ok) p.resolve(r.data); else p.reject(new Error(r.error)); } } });
});
function command(type, data = {}) { return new Promise((resolve, reject) => { const id = `deployment-${++counter}`; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ type, id, ...data })); }); }
assert.equal(initial.version, VERSION);
const browser = await chromium.launch({ headless: true }), errors = [], report = [], created = new Set();
try {
  for (const [agent, device] of [['pi', 'desktop'], ['codex', 'phone']]) {
    const ctx = await browser.newContext(device === 'phone' ? devices['Pixel 5'] : {}), p = await ctx.newPage();
    try {
      p.on('pageerror', e => errors.push(e.message)); await p.goto(`${url}/#token=${encodeURIComponent(token)}`); await expect(p.locator('#connection')).toHaveText('● 已连接');
      assert.equal(await p.evaluate(() => isSecureContext), false); assert.equal(await p.evaluate(() => typeof crypto.randomUUID), 'undefined');
      if (device === 'phone') await p.locator('#sidebarToggle').click();
      const title = `部署验收-${agent}-${Date.now()}`;
      await p.locator('#newSession').click(); await p.locator('#agent').selectOption(agent); await p.locator('#sessionName').fill(title); await p.locator('#cwd').fill('app_connect_ai/bridge'); await p.locator('#createButton').click();
      await expect(p.locator('#createDialog')).not.toBeVisible({ timeout: 65000 }); await expect(p.locator('#send')).toBeEnabled();
      const session = (await command('list')).find(s => s.title === title); assert.ok(session); created.add(session.id);
      const alt = session.models.find(m => m.id !== session.model && (m.id === 'gpt-6-sol' || m.id.endsWith('/gpt-6-sol'))); assert.ok(alt);
      await p.locator('#model').selectOption(alt.id); await expect.poll(async () => (await command('list')).find(s => s.id === session.id).model).toBe(alt.id);
      await expect(p.locator('#send')).toBeEnabled(); const marker = `DEPLOYMENT_${agent.toUpperCase()}_OK`;
      await p.locator('#prompt').fill(`请用工具读取 package.json，确认版本为${VERSION}。不要写文件；只回复 ${marker} ${VERSION}。`); await p.locator('#send').click();
      await expect(p.locator('.entry.assistant').last()).toContainText(marker, { timeout: 140000 }); await expect(p.locator('#status')).toContainText('已完成', { timeout: 140000 });
      const finished = (await command('list')).find(s => s.id === session.id); assert.ok(finished.tools > 0); assert.equal(finished.model, alt.id);
      await p.reload(); await expect(p.locator('.entry.assistant').last()).toContainText(marker);
      await menuClick(p, 'deleteSession'); await p.locator('#confirmDelete').click(); await expect.poll(async () => (await command('list')).some(s => s.id === session.id)).toBe(false); created.delete(session.id);
      report.push({ agent, viewport: device, realModelInference: true, readOnlyTools: true, reloadHistory: true, delete: true, pass: true });
    } finally { await ctx.close(); }
  }
  const remaining = await command('list'); assert.ok(initial.sessions.every(s => remaining.some(x => x.id === s.id)), 'Pre-existing sessions must remain untouched'); assert.deepEqual(errors, []);
  writeFileSync(new URL('../../artifacts/pi-web-live-deployment.json', import.meta.url), JSON.stringify({ version: initial.version, endpoint: 'existing Linux LAN HTTP service :8787', userSessionsPreserved: true, pass: report.length === 2, scenarios: report }, null, 2));
  console.log('Existing Linux :8787 deployment: desktop Pi + phone Codex, real inference/model/history/delete passed; pre-existing histories preserved.');
} finally { for (const sessionId of created) await command('delete', { sessionId }).catch(() => {}); ws.close(); await browser.close(); }
