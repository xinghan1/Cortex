import test from 'node:test';
import assert from 'node:assert/strict';
import { selectModelContext } from '../src/core/model-context.cjs';

test('switching connections preserves the archive and resets only the model context, including after restart', () => {
  const session = { id: 'chat', messages: [{ role: 'user', content: '旧问题' }], events: [{ type: 'run-end' }],
    modelContext: { connectionIdentity: 'relay', startIndex: 0, nativeSessionId: 'chat' },
    contextCheckpoint: { version: 1 }, contextUsage: { provider: 'relay' } };
  assert.equal(selectModelContext(session, { connectionIdentity: 'deepseek', provider: 'deepseek' }), true);
  assert.equal(session.id, 'chat'); assert.equal(session.messages.length, 1); assert.equal(session.events.length, 1);
  assert.equal(session.modelContext.startIndex, 1); assert.notEqual(session.modelContext.nativeSessionId, 'chat');
  assert.deepEqual(session.contextCheckpoint, {}); assert.deepEqual(session.contextUsage, {});
  const restarted = JSON.parse(JSON.stringify(session)); restarted.messages.push({ role: 'user', content: '继续' });
  assert.equal(selectModelContext(restarted, { connectionIdentity: 'deepseek', provider: 'deepseek' }), false);
  assert.deepEqual(restarted.modelContext, session.modelContext);
  assert.equal(selectModelContext(restarted, { connectionIdentity: 'relay', provider: 'relay' }), true);
  assert.equal(restarted.modelContext.startIndex, 2); assert.notEqual(restarted.modelContext.nativeSessionId, session.modelContext.nativeSessionId);
});

test('legacy sessions recognize account and provider changes without starting a new chat', () => {
  for (const options of [{ accountChanged: true }, { provider: 'deepseek', catalogKey: 'new' }]) {
    const session = { id: 'old', messages: [{ role: 'user', content: '旧问题' }], contextUsage: { provider: 'relay', connectionKey: 'old' } };
    assert.equal(selectModelContext(session, { connectionIdentity: 'new', ...options }), true);
    assert.equal(session.id, 'old'); assert.equal(session.modelContext.startIndex, 1);
  }
});
