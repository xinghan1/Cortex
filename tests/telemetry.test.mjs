import test from 'node:test';
import assert from 'node:assert/strict';
import { RunTelemetry } from '../src/core/telemetry.mjs';

test('live rate is marked estimated and final rate uses API output and model time only', () => {
  let now = 0; const events = [];
  const meter = new RunTelemetry({ emit: e => events.push(e), clock: () => now });
  meter.begin();
  assert.equal(events.at(-1).tokensPerSecond, null);
  now = 1000; meter.progress({ estimatedOutputTokens: 20, phase: 'generating' });
  assert.equal(events.at(-1).tokensPerSecond, 20);
  assert.equal(events.at(-1).estimated, true);
  now = 2000; meter.finish({ inputTokens: 100, outputTokens: 50 });
  meter.setPhase('tool');
  now = 62000; meter.publish();
  assert.equal(events.at(-1).tokensPerSecond, null);
  meter.begin(); now = 63000;
  meter.progress({ estimatedOutputTokens: 10, phase: 'generating' });
  meter.finish({ inputTokens: 200, outputTokens: 40 });
  meter.setPhase('completed');
  assert.equal(events.at(-1).tokensPerSecond, 30);
  assert.equal(events.at(-1).modelMs, 3000);
  assert.equal(events.at(-1).estimated, false);
  assert.equal(events.at(-1).inputTokens, 300);
});

test('missing or partial usage never becomes an exact final speed', () => {
  let now = 0; const events = [];
  const meter = new RunTelemetry({ emit: e => events.push(e), clock: () => now });
  meter.begin(); now = 1000;
  meter.progress({ estimatedOutputTokens: 25, phase: 'thinking' });
  meter.finish({ inputTokens: 10, outputTokens: 5 }, { reported: true, partial: true });
  meter.setPhase('completed');
  assert.equal(events.at(-1).estimated, true);
  assert.equal(events.at(-1).incomplete, true);
  assert.equal(events.at(-1).outputTokens, 5);
});
