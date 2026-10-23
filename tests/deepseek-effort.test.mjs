import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/renderer/deepseek-effort.js', import.meta.url), 'utf8');
const context = { module: { exports: {} } };
vm.runInNewContext(source, context);
const { resolve, update } = context.module.exports;
const selected = { provider: 'deepseek', modelId: 'deepseek-v4-pro', effort: 'high', known: true, available: true, options: ['none', 'low', 'high', 'max'] };

test('DeepSeek photos follow semantic effort rather than the slider position', () => {
  for (const [effort, photo] of Object.entries({ none: 'off', low: 'low', high: 'high', max: 'max' })) {
    assert.equal(resolve({ ...selected, effort }), photo);
  }
  assert.equal(resolve({ ...selected, effort: 'high', options: ['none', 'high'] }), 'high');
  assert.equal(resolve({ ...selected, effort: 'unsupported' }), null);
});

test('real DeepSeek model IDs work across providers while names and partial matches do not', () => {
  for (const modelId of ['deepseek-v4-pro', 'deepseek-ai/deepseek-v4-pro', 'deepseek-r1:8b', 'vendor/DeepSeek-V4-Pro', 'deepseek']) {
    assert.equal(resolve({ ...selected, provider: 'openai', modelId }), 'high', modelId);
  }
  for (const modelId of ['gpt-4.1', 'notdeepseek', 'gpt-deepseeker', 'vendor/notdeepseek-v4', 'vendor/deepseeker']) {
    assert.equal(resolve({ ...selected, provider: 'openai', modelId, displayName: 'DeepSeek-V4-Pro' }), null, modelId);
  }
  assert.equal(resolve({ ...selected, modelId: 'official-custom-alias' }), 'high');
});

test('catalogue defaults are used only when known and supported', () => {
  for (const [defaultEffort, photo] of Object.entries({ none: 'off', low: 'low', high: 'high', max: 'max' })) {
    assert.equal(resolve({ ...selected, effort: 'default', defaultEffort }), photo);
  }
  assert.equal(resolve({ ...selected, effort: 'default', defaultEffort: 'high', known: false }), null);
  assert.equal(resolve({ ...selected, effort: 'default' }), null);
  assert.equal(resolve({ ...selected, effort: 'default', defaultEffort: 'max', options: ['low', 'high'] }), null);
  assert.equal(resolve({ ...selected, effort: 'max', available: false }), null);
});

test('relay and Ollama visual aliases leave the original reasoning configuration unchanged', () => {
  for (const [effort, photo] of Object.entries({ minimal: 'low', medium: 'high', xhigh: 'high', enabled: 'high' })) {
    const selection = Object.freeze({ ...selected, provider: 'ollama', modelId: 'deepseek-r1:8b', effort, options: Object.freeze([effort]) });
    assert.equal(resolve(selection), photo);
    assert.equal(resolve({ ...selection, effort: 'default', defaultEffort: effort }), photo);
    assert.equal(selection.effort, effort);
  }
});

test('card decoration is cleared when the model or availability changes', () => {
  const card = { dataset: { existing: 'preserved' } };
  update(card, selected);
  assert.equal(card.dataset.deepseekEffort, 'high');
  update(card, { ...selected, effort: 'none' });
  assert.equal(card.dataset.deepseekEffort, 'off');
  update(card, { ...selected, provider: 'openai', modelId: 'gpt-4.1' });
  assert.equal(card.dataset.deepseekEffort, undefined);
  update(card, selected);
  update(card, { ...selected, available: false });
  assert.equal(card.dataset.deepseekEffort, undefined);
  assert.equal(card.dataset.existing, 'preserved');
  assert.doesNotThrow(() => update(null, selected));
});
