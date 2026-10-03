// Release gate: real CLI agents, real Linux-interface HTTP, real browser UI.
// No agentFactory/mock is supplied. Test credentials and transcripts stay in a private temp root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, devices } from 'playwright';
import { expect } from '@playwright/test';
import { menuClick } from './browser-actions.js';
import { createBridge, linuxLanUrl } from '../src/server.js';

const report = [];
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'linux-real-web-'));
  const contextMarker = `CONTEXT_${randomUUID().slice(0, 8)}`;
  writeFileSync(join(root, 'README.md'), `This is an isolated browser integration test.\nThe unique test marker is: ${contextMarker}\n`);
  const bridge = createBridge({ root, quiet: true });
  await new Promise(r => bridge.server.listen(0, '0.0.0.0', r));
  const url = linuxLanUrl(bridge.server.address().port);
  assert.ok(!url.includes('127.0.0.1') && !url.includes('localhost'), 'A non-loopback Linux interface is mandatory for this gate');
  t.after(async () => { await bridge.close(); rmSync(root, { recursive: true, force: true }); });
  return { bridge, root, url, contextMarker };
}
async function login(page, url, token) {
  await page.goto(url); assert.equal(await page.evaluate(() => window.isSecureContext), false);
  assert.equal(await page.evaluate(() => typeof crypto.randomUUID), 'undefined');
  await page.locator('#token').fill(token); await page.locator('#loginButton').click();
  await expect(page.locator('#connection')).toHaveText('● 已连接');
}
async function createChat(page, agent, title) {
  if (await page.locator('#sidebarToggle').isVisible()) await page.locator('#sidebarToggle').click();
  await page.locator('#newSession').click(); await page.locator('#agent').selectOption(agent);
  await page.locator('#sessionName').fill(title); await page.locator('#createButton').click();
  await expect(page.locator('#createDialog')).not.toBeVisible({ timeout: 65000 });
  await expect(page.locator('#title')).toHaveText(title); await expect(page.locator('#send')).toBeEnabled();
}
async function send(page, text, marker) {
  await page.locator('#prompt').fill(text); await page.locator('#send').click();
  // Wait for THIS unique reply before completion: the previous turn can still say completed at click time.
  await expect(page.locator('.entry.assistant').last()).toContainText(marker, { timeout: 140000 });
  await expect(page.locator('#status')).toContainText('已完成', { timeout: 140000 });
}

test('real Linux web release gate', { timeout: 1000000 }, async t => {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  for (const viewport of ['desktop', 'phone']) for (const agent of ['pi', 'codex']) {
    await t.test(`${viewport} HTTP UI → real ${agent}: context, real model inference, other device, delete`, { timeout: 190000 }, async t => {
      const { bridge, root, url, contextMarker } = await fixture(t);
      const context = await browser.newContext(viewport === 'phone' ? devices['Pixel 5'] : { viewport: { width: 1400, height: 950 } });
      t.after(() => context.close()); const page = await context.newPage(), errors = [];
      page.on('pageerror', e => errors.push(e.message)); await login(page, url, bridge.token);
      const title = `真实 ${agent} · ${viewport}`; await createChat(page, agent, title);
      const session = [...bridge.sessions.values()].find(s => s.title === title); assert.ok(session?.agent?.child?.pid, 'Must have an actual agent child process');
      const pid = session.agent.child.pid, first = `HTTP_FIRST_${randomUUID().slice(0, 8)}`, second = `HTTP_SECOND_${randomUUID().slice(0, 8)}`;
      await send(page, `请先用工具读取 README.md，不要写文件。读取完成后只回复 ${first}。`, first);
      assert.ok(session.tools > 0); const toolsBefore = session.tools;
      const alternate = session.models.find(m => m.id === 'gpt-6-sol' || m.id.endsWith('/gpt-6-sol'));
      assert.ok(alternate, 'Need a real second authenticated model for inference verification');
      await page.locator('#model').selectOption(alternate.id); await expect.poll(() => session.model).toBe(alternate.id);
      await expect(page.locator('#model')).toBeEnabled();
      if (agent === 'pi') { const state = await session.agent.request({ type: 'get_state' }); assert.equal(`${state.model.provider}/${state.model.id}`, alternate.id); }
      else assert.equal(session.agent.selected, alternate.id);
      await send(page, `上一轮 README.md 中的唯一测试标记是什么？请使用对话上下文，不要再次读取文件或调用工具。写出该标记，并在末尾追加 ${second}。`, second);
      await expect(page.locator('.entry.assistant').last()).toContainText(contextMarker);
      assert.equal(session.turns, 2); assert.equal(session.tools, toolsBefore, 'Second reply must use retained context, not read the file again');
      assert.equal(session.status, 'completed');
      await page.locator('#pair').click(); await expect(page.locator('#pairDialog')).toBeVisible();
      await page.locator('#pairCredentials').check(); await expect(page.locator('#pairUrl')).toHaveValue(/#token=/);
      const browserUrl = await page.locator('#pairUrl').inputValue();
      assert.ok(browserUrl.startsWith(`${url}/#token=`)); await page.locator('#closePair').click();
      const peerContext = await browser.newContext({ ...devices['Pixel 5'] }); t.after(() => peerContext.close()); const peer = await peerContext.newPage();
      peer.on('pageerror', e => errors.push(e.message)); await peer.goto(browserUrl);
      await expect(peer.locator('#connection')).toHaveText('● 已连接'); assert.equal(new URL(peer.url()).hash, '');
      await expect(peer.locator('.entry.assistant').last()).toContainText(contextMarker);
      if (agent === 'pi') {
        await page.locator('#prompt').fill('/lan-check'); await page.locator('#send').click();
        await expect(peer.locator('.choice')).toContainText('局域网交互检查');
        await peer.locator('.choice').getByRole('button', { name: '继续', exact: true }).click();
        await expect(page.locator('#status')).toContainText('已完成');
        assert.ok(session.events.some(e => e.event === 'notice' && e.text.includes('继续')));
      }
      await menuClick(page, 'renameSession'); await page.locator('#renameTitle').fill(title + ' 已验证');
      await page.locator('#renameForm').getByRole('button', { name: '保存名称' }).click(); await expect(peer.locator('#title')).toHaveText(title + ' 已验证');
      await page.reload(); await expect(page.locator('#connection')).toHaveText('● 已连接'); await expect(page.locator('#title')).toHaveText(title + ' 已验证');
      await expect(page.locator('.entry.assistant').last()).toContainText(contextMarker);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: `../artifacts/pi-web-real-${viewport}-${agent}.png` });
      await menuClick(peer, 'deleteSession'); await peer.locator('#confirmDelete').click();
      await expect(peer.locator('#deleteDialog')).not.toBeVisible({ timeout: 15000 }); await expect(page.locator('#emptyState')).toBeVisible();
      assert.equal(bridge.sessions.size, 0); assert.equal(existsSync(join(root, '.lan-agent', `${session.id}.jsonl`)), false);
      assert.ok(session.agent === null); assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      await peer.reload(); await expect(peer.locator('#connection')).toHaveText('● 已连接'); await expect(peer.locator('#emptyState')).toBeVisible();
      assert.deepEqual(errors, []);
      report.push({ viewport, agent, insecureHttp: true, browserRandomUuidUnavailable: true, actualChildProcess: true, modelUsedForSecondReply: alternate.id, replies: 2, retainedContext: true, crossDeviceShared: true, piRealChoice: agent === 'pi', deleteRemovedHistory: true, deleteStoppedProcess: true, pageErrors: errors, pass: true });
    });
  }
  await t.test('delete a real running Codex task from the phone web UI', { timeout: 150000 }, async t => {
    const { bridge, root, url } = await fixture(t), context = await browser.newContext(devices['Pixel 5']); t.after(() => context.close());
    const page = await context.newPage(); await login(page, url, bridge.token); await createChat(page, 'codex', '运行中删除验证');
    const session = [...bridge.sessions.values()][0], child = session.agent.child;
    await page.locator('#prompt').fill('请调用命令工具执行 sleep 20，等命令结束后回复 DONE。不要写文件。'); await page.locator('#send').click();
    await expect.poll(() => session.tools, { timeout: 90000 }).toBeGreaterThan(0);
    await menuClick(page, 'deleteSession'); await page.locator('#confirmDelete').click(); await expect(page.locator('#emptyState')).toBeVisible({ timeout: 15000 });
    assert.equal(bridge.sessions.size, 0); assert.ok(child.exitCode !== null || child.signalCode !== null); assert.equal(existsSync(join(root, '.lan-agent', `${session.id}.jsonl`)), false);
    report.push({ agent: 'codex', viewport: 'phone', runningTaskDeletion: true, deleteStoppedProcess: true, historyRemoved: true, pass: true });
  });
  writeFileSync(new URL('../../artifacts/pi-web-real-web-report.json', import.meta.url), JSON.stringify({ expectedScenarios: 5, passedScenarios: report.length, pass: report.length === 5, scenarios: report }, null, 2));
});
