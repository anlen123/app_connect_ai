import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PiAgent } from '../src/agents.js';
test('pi recovered retry completes successfully; failed final message stays failed', () => {
  const events = [], agent = Object.create(PiAgent.prototype);
  agent.emit = (type, data) => events.push({ type, ...data }); agent.ui = new Map();
  agent.receive({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'Transient failure' } });
  agent.receive({ type: 'agent_end', willRetry: true }); assert.ok(!events.some(e => e.type === 'completed'));
  agent.receive({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'stop' } });
  agent.receive({ type: 'agent_settled' }); assert.equal(events.at(-1).status, 'completed');
  agent.receive({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'Final failure' } });
  agent.receive({ type: 'agent_settled' }); assert.equal(events.at(-1).status, 'error');
});
