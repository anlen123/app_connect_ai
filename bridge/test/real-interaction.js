import { createBridge } from '../src/server.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'lan-pi-ui-')), b = createBridge({ root, quiet: true });
await new Promise(r => b.server.listen(0, '127.0.0.1', r));
try {
  const session = await b.handle({ type: 'create', agent: 'pi' });
  const prompt = b.handle({ type: 'prompt', sessionId: session.id, text: '/lan-check' });
  const deadline = Date.now() + 20000; let choice;
  while (Date.now() < deadline) { choice = (await b.handle({ type: 'subscribe', sessionId: session.id })).choices[0]; if (choice) break; await new Promise(r => setTimeout(r, 25)); }
  if (!choice || choice.title !== '局域网交互检查') throw new Error('Real pi extension did not produce a dialog');
  await b.handle({ type: 'answer', sessionId: session.id, requestId: choice.requestId, answer: { value: '继续' } }); await prompt;
  const result = await b.handle({ type: 'subscribe', sessionId: session.id });
  if (!result.events.some(e => e.event === 'notice' && e.text.includes('继续')) || result.status !== 'completed') throw new Error('Real pi did not receive the selected answer');
  const report = { agent: 'pi', realRpcDialog: true, answeredWhilePromptPending: true, receivedAnswer: true, completed: true };
  writeFileSync(new URL('../../artifacts/real-pi-interaction.json', import.meta.url), JSON.stringify(report, null, 2)); console.log(report);
} finally { await b.close(); rmSync(root, { recursive: true, force: true }); }
