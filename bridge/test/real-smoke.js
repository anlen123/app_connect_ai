import { PiAgent, CodexAgent } from '../src/agents.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const reports = [];
for (const [name, Agent] of [['pi', PiAgent], ['codex', CodexAgent]]) {
  const cwd = mkdtempSync(join(tmpdir(), 'lan-real-')); const events = [];
  let settled; const done = new Promise(r => settled = r);
  const agent = new Agent(cwd, (type, data) => { events.push({ type, ...data }); if (type === 'completed' || type === 'error' && data.fatal) settled(); });
  const report = { agent: name };
  try {
    const info = await agent.init(); report.models = info.models.length; report.model = info.model;
    if (!info.models.length) throw new Error('No authenticated models available');
    await agent.model(info.models.some(m => m.id === info.model) ? info.model : info.models[0].id);
    await agent.prompt('请调用文件读取工具或命令工具查看当前目录（不要写文件），然后只回复 LAN_SMOKE_OK。');
    let timer; await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Smoke timed out after 120s')), 120000); })]); clearTimeout(timer);
    report.completed = events.findLast(e => e.type === 'completed')?.status;
    report.text = events.filter(e => e.channel === 'assistant' && e.type === 'content').map(e => e.text).join('\n');
    report.thinking = events.filter(e => e.channel === 'thinking').length;
    report.tools = events.filter(e => e.type === 'tool').length;
    report.errors = events.filter(e => e.type === 'error').map(e => e.text);
    report.pass = report.completed === 'completed' && report.text.includes('LAN_SMOKE_OK') && report.tools > 0;
  } catch (e) { report.error = e.message; report.pass = false; }
  finally { agent.close(); }
  reports.push(report); console.log(JSON.stringify(report));
}
writeFileSync(new URL('../../artifacts/real-agent-smoke.json', import.meta.url), JSON.stringify(reports, null, 2));
if (reports.some(r => !r.pass)) process.exitCode = 1;
