import { test, expect } from '@playwright/test';
import { menuClick } from '../test/browser-actions.js';

const TOKEN = 'CustomPair_42';
async function login(page) {
  await page.goto('/');
  expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe('undefined');
  await page.locator('#token').fill(TOKEN); await page.locator('#loginButton').click();
  await expect(page.locator('#connection')).toHaveText('● 已连接');
}
async function newChat(page, agent, title) {
  if (await page.locator('#sidebarToggle').isVisible()) { await page.locator('#sidebarToggle').click(); }
  await page.locator('#newSession').click();
  await expect(page.locator('#createDialog')).toBeVisible();
  await page.locator('#agent').selectOption(agent); await page.locator('#sessionName').fill(title);
  await page.locator('#createButton').click(); await expect(page.locator('#createDialog')).not.toBeVisible();
  await expect(page.locator('#title')).toHaveText(title); await expect(page.locator('#send')).toBeEnabled();
}
async function removeCurrent(page) {
  await menuClick(page, 'deleteSession'); await page.locator('#confirmDelete').click();
  await expect(page.locator('#deleteDialog')).not.toBeVisible();
}
for (const agent of ['pi', 'codex']) {
  test(`${agent}: LAN HTTP create, chat, model, rename, reload, delete and empty state`, async ({ page }, info) => {
    const errors = []; page.on('pageerror', e => errors.push(e.message)); await login(page);
    const title = `${info.project.name}-${agent}`;
    await newChat(page, agent, title);
    await expect(page.locator('#sessionAgent')).toHaveText(agent.toUpperCase());
    await page.locator('#model').selectOption('test/model-b'); await expect(page.locator('#model')).toHaveValue('test/model-b');
    await page.locator('#prompt').fill('Linux 网页聊天验证'); await page.locator('#send').click();
    await expect(page.locator('.entry.thinking')).toContainText('正在分析局域网任务');
    await expect(page.locator('.entry.assistant')).toContainText('收到任务：Linux 网页聊天验证');
    await expect(page.locator('#plan')).toContainText('等待授权');
    await expect(page.locator('.entry.tool')).toContainText('读取完成');
    await expect(page.locator('.choice')).toContainText('选择执行方式');
    await page.locator('.choice').getByRole('button', { name: '继续', exact: true }).click();
    await expect(page.locator('#status')).toContainText('已完成');
    await expect(page.locator('.entry.assistant').last()).toContainText('选择结果：继续');
    await menuClick(page, 'renameSession'); await page.locator('#renameTitle').fill(title + '-renamed');
    await page.locator('#renameForm').getByRole('button', { name: '保存名称' }).click(); await expect(page.locator('#title')).toHaveText(title + '-renamed');
    await page.reload(); await expect(page.locator('#connection')).toHaveText('● 已连接');
    await expect(page.locator('#title')).toHaveText(title + '-renamed'); await expect(page.locator('.entry.assistant').last()).toContainText('选择结果：继续');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `../artifacts/pi-web-${info.project.name}-${agent}.png` });
    await removeCurrent(page); await expect(page.locator('#emptyState')).toBeVisible(); await expect(page.locator('#send')).toBeDisabled();
    await page.reload(); await expect(page.locator('#connection')).toHaveText('● 已连接'); await expect(page.locator('#emptyState')).toBeVisible();
    expect(errors).toEqual([]);
  });
}
test('phone browser link pairs directly and another device sees chat and deletion', async ({ page, browser, baseURL }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message)); await login(page);
  await newChat(page, 'pi', '跨设备共享');
  await page.locator('#pair').click(); await expect(page.locator('#pairDialog')).toBeVisible();
  await page.locator('#pairCredentials').check(); await expect(page.locator('#pairUrl')).toHaveValue(/#token=/);
  const url = await page.locator('#pairUrl').inputValue(); expect(new URL(url).origin).toBe(baseURL); expect(url).toContain('#token=');
  await expect(page.locator('#qr')).toHaveAttribute('src', /^data:image\/png/); await page.locator('#closePair').click();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = await context.newPage(); phone.on('pageerror', e => errors.push(e.message)); const requests = []; phone.on('request', r => requests.push(r.url()));
  await phone.goto(url); await expect(phone.locator('#connection')).toHaveText('● 已连接'); expect(new URL(phone.url()).hash).toBe('');
  expect(requests.every(url => !url.includes(TOKEN))).toBe(true); await expect(phone.locator('#title')).toHaveText('跨设备共享');
  await phone.locator('#prompt').fill('手机网页发出的问题'); await phone.locator('#prompt').press('Enter');
  await expect(phone.locator('#status')).toContainText('就绪'); // Phone Enter is a newline, not an accidental send.
  await phone.locator('#send').click(); await expect(page.locator('.entry.assistant')).toContainText('手机网页发出的问题');
  await expect(phone.locator('.choice')).toBeVisible(); await phone.locator('.choice').getByRole('button', { name: '继续', exact: true }).click();
  await expect(page.locator('#status')).toContainText('已完成'); await removeCurrent(phone); await expect(page.locator('#emptyState')).toBeVisible();
  await context.close(); expect(errors).toEqual([]);
});
test('invalid login and invalid project directory show useful errors without broken state', async ({ page }) => {
  await page.goto('/'); await page.locator('#token').fill('incorrect-token-0123456789012345'); await page.locator('#loginButton').click();
  await expect(page.locator('#loginError')).toContainText('配对码不正确');
  await page.locator('#token').fill(TOKEN); await page.locator('#loginButton').click(); await expect(page.locator('#connection')).toHaveText('● 已连接');
  if (await page.locator('#sidebarToggle').isVisible()) await page.locator('#sidebarToggle').click();
  await page.locator('#newSession').click(); await page.locator('#cwd').fill('definitely-missing-folder'); await page.locator('#createButton').click();
  await expect(page.locator('#createError')).toContainText('不存在'); await expect(page.locator('#createButton')).toBeEnabled();
  await page.locator('#cancelCreate').click(); await expect(page.locator('#emptyState')).toBeVisible();
});

test('pi-web theme, safe Markdown, collapsed tools, copy/export and manual pairing', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message)); await login(page);
  const before = await page.locator('html').getAttribute('data-theme'); await page.locator('#theme').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', before === 'dark' ? 'light' : 'dark');
  await newChat(page, 'pi', 'Markdown 工作区');
  const payload = '\n\n# Markdown 标题\n\n**加粗内容**\n\n```js\nconst answer = 42;\n```\n\n| 项目 | 值 |\n| --- | --- |\n| test | 42 |\n\n<img src="https://example.invalid/leak" onerror="window.pwned=1"><script>window.pwned=2</script>[bad](javascript:alert(1))';
  await page.locator('#prompt').fill(payload); await page.locator('#send').click();
  await expect(page.locator('.entry.assistant .markdown h1')).toHaveText('Markdown 标题');
  await expect(page.locator('.markdown strong')).toHaveText('加粗内容'); await expect(page.locator('.markdown table')).toContainText('test');
  expect(await page.locator('.markdown img,.markdown script,.markdown [onerror],.markdown a[href^="javascript:"]').count()).toBe(0);
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
  await expect(page.locator('.entry.thinking')).toHaveAttribute('open', '');
  await expect(page.locator('.entry.thinking .entry-body')).toBeVisible();
  await page.locator('.entry.thinking > summary').click(); await expect(page.locator('.entry.thinking .entry-body')).not.toBeVisible();
  await page.locator('.entry.thinking > summary').click();
  await page.locator('.code-copy').click(); await expect(page.locator('#toast')).toContainText('已复制');
  await expect(page.locator('.choice')).toBeVisible(); await page.locator('.choice').getByRole('button', { name: '继续', exact: true }).click(); await expect(page.locator('#status')).toContainText('已完成');
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#exportSession').click()]); expect(download.suggestedFilename()).toBe('conversation.md');
  await page.locator('#pair').click(); await expect(page.locator('#pairDialog')).toBeVisible(); expect(new URL(await page.locator('#pairUrl').inputValue()).hash).toBe(''); await page.locator('#closePair').click();
  await page.screenshot({ path: `../artifacts/pi-web-workspace-${info.project.name}.png` });
  await page.reload(); await expect(page.locator('html')).toHaveAttribute('data-theme', before === 'dark' ? 'light' : 'dark'); await expect(page.locator('.markdown h1')).toHaveText('Markdown 标题');
  await removeCurrent(page); await page.locator('#logout').click(); await expect(page.locator('#token')).toHaveValue(''); expect(errors).toEqual([]);
});

test('project filter, session menus and desktop configurable Enter behavior', async ({ page }, info) => {
  await login(page);
  for (const project of ['project-alpha', 'project-beta']) {
    if (await page.locator('#sidebarToggle').isVisible()) await page.locator('#sidebarToggle').click();
    await page.locator('#newSession').click(); await page.locator('#sessionName').fill(project); await page.locator('#cwd').fill(project); await page.locator('#createButton').click(); await expect(page.locator('#createDialog')).not.toBeVisible();
  }
  if (await page.locator('#sidebarToggle').isVisible()) await page.locator('#sidebarToggle').click();
  const options = await page.locator('#projectFilter option').evaluateAll(nodes => nodes.map(n => ({ text: n.textContent, value: n.value })));
  await page.locator('#projectFilter').selectOption(options.find(o => o.text === 'project-alpha').value); await expect(page.locator('.session')).toHaveCount(1); await page.locator('.session').click();
  await page.locator('#prompt').fill('keyboard draft');
  if (info.project.name.startsWith('desktop')) { await page.locator('#enterMode').click(); await page.locator('#prompt').press('Enter'); await expect(page.locator('#status')).toContainText('就绪'); await page.locator('#prompt').press('Control+Enter'); }
  else { await page.locator('#prompt').press('Enter'); await expect(page.locator('#status')).toContainText('就绪'); await page.locator('#send').click(); }
  await expect(page.locator('.entry.assistant')).toContainText('keyboard draft'); await expect(page.locator('.choice')).toBeVisible(); await page.locator('.choice').getByRole('button', { name: '继续', exact: true }).click(); await expect(page.locator('#status')).toContainText('已完成');
  await removeCurrent(page); await expect(page.locator('#title')).toHaveText('project-beta'); await removeCurrent(page); await expect(page.locator('#emptyState')).toBeVisible();
});
