// Actual providers + non-loopback HTTP. Isolated data; never starts production.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, devices } from 'playwright';
import { expect } from '@playwright/test';
import { createBridge, linuxLanUrl } from '../src/server.js';
import { menuClick } from './browser-actions.js';

const results = [];
test('actual Pi/Codex native resume and exposed thinking over Linux LAN HTTP', { timeout: 1000000 }, async t => {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  for (const viewport of ['desktop', 'phone']) for (const kind of ['pi', 'codex']) await t.test(`${viewport}: ${kind}`, { timeout: 220000 }, async t => {
    const root = mkdtempSync(join(tmpdir(), 'lan-native-resume-'));
    let bridge = createBridge({ root, quiet: true });
    await new Promise(r => bridge.server.listen(0, '0.0.0.0', r));
    const port = bridge.server.address().port, url = linuxLanUrl(port);
    assert.ok(!/localhost|127\.0\.0\.1/.test(url));
    t.after(async () => { await bridge.close(); rmSync(root, { recursive: true, force: true }); });
    const context = await browser.newContext(viewport === 'phone' ? devices['Pixel 5'] : { viewport: { width: 1400, height: 950 } }); t.after(() => context.close());
    const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(url); assert.equal(await page.evaluate(() => isSecureContext), false);
    assert.equal(await page.evaluate(() => typeof crypto.randomUUID), 'undefined');
    await page.locator('#token').fill(bridge.token); await page.locator('#loginButton').click(); await expect(page.locator('#connection')).toHaveText('● 已连接');
    if (await page.locator('#sidebarToggle').isVisible()) await page.locator('#sidebarToggle').click();
    await page.locator('#newSession').click(); await page.locator('#agent').selectOption(kind); await page.locator('#sessionName').fill(`${kind} 原生重启`);
    await page.locator('#createButton').click(); await expect(page.locator('#createDialog')).not.toBeVisible({ timeout: 65000 });
    await expect(page.locator('#emptyState')).toBeVisible(); assert.equal(await page.locator('.entry.progress').count(), 0);
    let session = [...bridge.sessions.values()][0]; const id = session.id, original = { ...session.native }, oldPid = session.agent.child.pid;
    await page.evaluate(() => {
      window.liveThinking = []; window.thinkingActivity = [];
      new MutationObserver(() => {
        if (!document.getElementById('status').textContent.includes('正在处理')) return;
        for (const node of document.querySelectorAll('.entry.thinking[open] .entry-body')) if (node.textContent && node.getBoundingClientRect().height > 0) window.liveThinking.push({ text: node.textContent, time: Date.now() });
        const activity = document.getElementById('agentActivity');
        if (!activity.hidden && activity.textContent.startsWith('思考中')) window.thinkingActivity.push(Date.now());
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    const secret = `REMEMBER_${randomUUID()}`, first = `FIRST_${randomUUID().slice(0, 8)}`;
    await page.locator('#prompt').fill(`请记住随机口令 ${secret}。求满足 n≡17 (mod 101)、n≡23 (mod 103)、n≡31 (mod 107) 的最小正整数，并给出简短公开验算摘要，不要调用工具或读写文件，最后追加 ${first}。`); await page.locator('#send').click();
    await expect(page.locator('.entry.assistant').last()).toContainText(first, { timeout: 140000 }); await expect(page.locator('#status')).toContainText('已完成', { timeout: 140000 });
    const samples = await page.evaluate(() => window.liveThinking), activitySamples = await page.evaluate(() => window.thinkingActivity);
    if (session.events.some(e => e.event === 'activity' && e.phase === 'thinking')) assert.ok(activitySamples.length > 0, 'Actual thinking-start must be visibly indicated even without public text');
    const thinkingDeltas = session.events.filter(e => e.event === 'delta' && e.channel === 'thinking' && e.text);
    // Providers may legitimately omit public summaries on an individual turn.
    // Require live visibility whenever a delta exists; never manufacture thinking.
    if (thinkingDeltas.length) assert.ok(samples.length > 0, 'Thinking body must be visibly updated before completion');
    else if (!session.events.some(e => e.channel === 'thinking' && e.text)) assert.equal(await page.locator('.entry.thinking').count(), 0);
    const oldKeys = new Set(session.events.filter(e => ['delta', 'content'].includes(e.event)).map(e => e.key));
    const alternative = session.models.find(m => m.id === 'gpt-6-sol' || m.id.endsWith('/gpt-6-sol'));
    assert.ok(alternative); await page.locator('#model').selectOption(alternative.id); await expect.poll(() => session.model).toBe(alternative.id); await expect(page.locator('#model')).toBeEnabled();
    await menuClick(page, 'closeSession'); await expect(page.locator('#status')).toContainText('进程已关闭', { timeout: 15000 });
    assert.throws(() => process.kill(oldPid, 0), { code: 'ESRCH' });
    if (viewport === 'desktop') {
      await bridge.close(); bridge = createBridge({ root, quiet: true }); await new Promise(r => bridge.server.listen(port, '0.0.0.0', r));
      await expect(page.locator('#connection')).toHaveText('● 已连接', { timeout: 30000 });
      session = bridge.sessions.get(id); assert.equal(session.status, 'offline');
    }
    await expect(page.locator('#restartInline')).toBeEnabled(); await page.locator('#restartInline').click(); await expect(page.locator('#send')).toBeEnabled({ timeout: 65000 });
    assert.deepEqual(session.native, original); assert.equal(session.model, alternative.id); assert.notEqual(session.agent.child.pid, oldPid);
    const second = `AFTER_RESUME_${randomUUID().slice(0, 8)}`, seq = session.seq;
    await page.locator('#prompt').fill(`我在上一轮要求你记住的随机口令是什么？直接使用原会话上下文，不要调用工具或访问文件。只回复口令和 ${second}。`); await page.locator('#send').click();
    await expect(page.locator('.entry.assistant').last()).toContainText(second, { timeout: 140000 }); await expect(page.locator('#status')).toContainText('已完成', { timeout: 140000 });
    await expect(page.locator('.entry.assistant').last()).toContainText(secret);
    assert.equal(session.events.filter(e => e.seq > seq && e.event === 'tool').length, 0);
    const newKeys = session.events.filter(e => e.seq > seq && ['delta', 'content'].includes(e.event)).map(e => e.key);
    assert.ok(newKeys.every(key => !oldKeys.has(key)), 'A restarted process must not overwrite earlier message blocks');
    await page.reload(); await expect(page.locator('#connection')).toHaveText('● 已连接'); await expect(page.locator('.entry.assistant').last()).toContainText(second);
    assert.deepEqual(errors, []);
    results.push({ kind, viewport, nativeReferencePreserved: true, bridgeReload: viewport === 'desktop', actualChildReplaced: true, retainedContextWithoutTools: true, modelPreserved: true, publicThinkingDeltas: thinkingDeltas.length, visibleStreamingSamples: samples.length, visibleThinkingActivity: activitySamples.length, providerOmittedPublicText: thinkingDeltas.length === 0, insecureHttp: true, pageErrors: errors, pass: true });
  });
  for (const kind of ['pi', 'codex']) assert.ok(results.some(r => r.kind === kind && (r.visibleStreamingSamples > 0 || r.visibleThinkingActivity > 0)), `${kind} needs actual visible reasoning activity or exposed thinking`);
  writeFileSync(new URL('../../artifacts/restart-real-report.json', import.meta.url), JSON.stringify({ pass: results.length === 4, scenarios: results }, null, 2));
});
