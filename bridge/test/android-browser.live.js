// Extra release check: actual Android Chrome with touch input (not desktop mobile emulation).
// Boot a test emulator/device with Chrome and adb, then run this script.
import assert from 'node:assert/strict';
import { _android as android } from 'playwright';
import { expect } from '@playwright/test';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBridge, linuxLanUrl } from '../src/server.js';
const devices = await android.devices();
const phone = devices.find(d => !process.env.ANDROID_SERIAL || d.serial() === process.env.ANDROID_SERIAL);
assert.ok(phone, 'Start an Android emulator/device with Chrome and adb first');
const context = await phone.launchBrowser({ viewport: null, hasTouch: true, args: ['--no-first-run', '--disable-fre', '--no-default-browser-check'] });
const page = context.pages()[0] || await context.newPage(), report = [];
const errors = []; page.on('pageerror', e => errors.push(e.message));
try {
  for (const agent of ['pi', 'codex']) {
    const root = mkdtempSync(join(tmpdir(), 'android-real-browser-'));
    writeFileSync(join(root, 'README.md'), 'Isolated actual Android Chrome integration test. Do not write files.');
    const b = createBridge({ root, quiet: true }); await new Promise(r => b.server.listen(0, '0.0.0.0', r));
    const url = linuxLanUrl(b.server.address().port);
    try {
      await page.goto(`${url}/#token=${encodeURIComponent(b.token)}`); await expect(page.locator('#connection')).toHaveText('● 已连接');
      const device = await page.evaluate(() => ({ userAgent: navigator.userAgent, secure: isSecureContext, width: innerWidth, coarse: matchMedia('(pointer:coarse)').matches, uuid: typeof crypto.randomUUID }));
      assert.ok(device.userAgent.includes('Android')); assert.equal(device.secure, false); assert.equal(device.uuid, 'undefined'); assert.equal(new URL(page.url()).hash, '');
      await page.locator('#sidebarToggle').tap(); await page.locator('#newSession').tap(); await page.locator('#agent').selectOption(agent);
      await page.locator('#sessionName').fill(`Android Chrome · ${agent}`); await page.locator('#createButton').tap(); await expect(page.locator('#createDialog')).not.toBeVisible({ timeout: 65000 });
      const session = [...b.sessions.values()][0], pid = session.agent.child.pid;
      const model = session.models.find(m => m.id === 'gpt-6-sol' || m.id.endsWith('/gpt-6-sol')); assert.ok(model);
      await page.locator('#model').selectOption(model.id); await expect.poll(() => session.model).toBe(model.id); await expect(page.locator('#send')).toBeEnabled();
      const marker = `ACTUAL_ANDROID_CHROME_${agent.toUpperCase()}_OK`;
      await page.locator('#prompt').fill(`请用工具读取 README.md，不要写文件，然后只回复 ${marker}。`); await page.locator('#send').tap();
      await expect(page.locator('.entry.assistant').last()).toContainText(marker, { timeout: 140000 }); await expect(page.locator('#status')).toContainText('已完成', { timeout: 140000 });
      assert.ok(session.tools > 0); assert.equal(session.status, 'completed'); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: `../artifacts/v1.1-actual-android-chrome-${agent}.png` });
      await page.locator('#deleteSession').tap(); await page.locator('#confirmDelete').tap(); await expect(page.locator('#emptyState')).toBeVisible({ timeout: 15000 });
      assert.equal(b.sessions.size, 0); assert.equal(existsSync(join(root, '.lan-agent', `${session.id}.jsonl`)), false); assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      report.push({ agent, actualAndroidChrome: true, device, selectedModelInference: model.id, realReply: true, deleteRemovedHistoryAndProcess: true, pass: true });
    } finally { await b.close(); rmSync(root, { recursive: true, force: true }); }
  }
  assert.deepEqual(errors, []); writeFileSync(new URL('../../artifacts/v1.1-actual-android-browser.json', import.meta.url), JSON.stringify({ pass: report.length === 2, scenarios: report }, null, 2));
  console.log('Actual Android Chrome: real Pi + Codex, LAN HTTP, model inference, chat, deletion all passed.');
} finally { await context.close(); await phone.close(); }
