import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const main = await fs.readFile(new URL('../src/main.cjs', import.meta.url), 'utf8');
const source = main.slice(main.indexOf('function recordLiveEvent('), main.indexOf('\nfunction rememberTerminalEvent('));
const create = () => {
  const context = vm.createContext({ approvals: new Map(), currentSession: { messages: [] } });
  vm.runInContext(source, context); const run = {};
  return { run, emit: event => context.recordLiveEvent(run, event) };
};
const output = (toolCallId, text, replace = false) => ({ type: 'command-output', toolCallId, text, ...(replace ? { replace: true } : {}) });
test('live replay keeps sanitized cumulative snapshots as replacements across interleaved tools', () => {
  const f = create();
  f.emit(output('a', 'first\n')); f.emit(output('b', 'other\n'));
  f.emit(output('a', 'first\nSECRET_PREFIX')); f.emit(output('a', 'first\n[redacted]\n', true));
  f.emit(output('a', 'last\n'));
  const values = new Map();
  for (const event of f.run.liveEvents) values.set(event.toolCallId, event.replace ? event.text : (values.get(event.toolCallId) || '') + event.text);
  assert.equal(values.get('a'), 'first\n[redacted]\nlast\n'); assert.equal(values.get('b'), 'other\n');
  assert.equal(f.run.liveEvents.length, 3); assert.equal(f.run.liveEvents.at(-1).replace, true);
});
test('ordinary command deltas still append and assistant replacement frames replace their replay prefix', () => {
  const f = create(); f.emit(output('a', 'one')); f.emit(output('a', 'two'));
  assert.equal(f.run.liveEvents[0].text, 'onetwo');
  f.emit({ type: 'text-delta', text: 'split prefix' }); f.emit({ type: 'text-delta', text: '[redacted]', replace: true });
  assert.equal(f.run.streamText, '[redacted]'); assert.equal(f.run.liveEvents.at(-1).text, '[redacted]');
});
