// Deterministic E2E agent; never enabled in production server.
import { createBridge } from '../src/server.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const factory = (kind, cwd, emit) => ({
  closed: false,
  async init() { return { model: 'test/model-a', models: [{ id: 'test/model-a', name: 'Model A' }, { id: 'test/model-b', name: 'Model B' }] }; },
  async model(id) { this.selected = id; },
  async prompt(text) {
    emit('delta', { channel: 'thinking', key: `${Date.now()}-thinking`, text: '正在分析局域网任务' });
    emit('delta', { channel: 'assistant', key: `${Date.now()}-answer`, text: '收到任务：' + text });
    emit('plan', { steps: [{ step: '分析请求', status: 'completed' }, { step: '等待授权', status: 'inProgress' }] });
    emit('tool', { key: 'test-tool', name: 'read', status: 'start', detail: { path: 'README.md' } });
    emit('tool', { key: 'test-tool', name: 'read', status: 'end', detail: '读取完成' });
    this.timer = setTimeout(() => emit('choice', { requestId: 'fixture-choice', kind: 'select', title: '选择执行方式', options: ['继续', '取消'] }), 800);
  },
  async answer(id, answer) { if (id !== 'fixture-choice') throw new Error('Unexpected ID'); emit('content', { channel: 'assistant', key: 'final-answer', text: '选择结果：' + answer.value }); this.timer = setTimeout(() => emit('completed', { status: 'completed' }), 800); },
  async abort() { clearTimeout(this.timer); emit('completed', { status: 'cancelled' }); },
  close() { clearTimeout(this.timer); this.closed = true; }
});
const b = createBridge({ root: mkdtempSync(join(tmpdir(), 'lan-fixture-')), token: 'test-only-token-0123456789abcdefgh', quiet: true, advertisedUrl: process.env.LAN_URL, agentFactory: factory });
const port = Number(process.env.PORT || 8788);
b.server.listen(port, '0.0.0.0', () => console.log(`Fixture listening ${port}`));
process.on('SIGTERM', async () => { await b.close(); process.exit(); });
