import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { SettingsCatalogSelections } from '../src/core/settings-model-catalog.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const connectionA = digest('synthetic-provider-a/account-a/protocol-a');
const connectionB = digest('synthetic-provider-b/account-b/protocol-b');
const model = (id, metadata = {}) => ({ id, displayName: `Display ${id}`, ...metadata });
const select = (grant, connection, id) => ({ selectionToken: grant.selectionToken, connection, model: id });

test('a preview grant binds its exact connection signature and original model IDs', () => {
  const selections = new SettingsCatalogSelections();
  const first = selections.register({ connection: connectionA, models: [model('gemini-high')] });
  const second = selections.register({ connection: connectionB, models: [model('other-route-low')] });
  assert.match(first.selectionToken, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
  assert.notEqual(first.selectionToken, second.selectionToken);
  assert.deepEqual(selections.validate(select(first, connectionA, 'gemini-high')), model('gemini-high'));
  assert.throws(() => selections.validate(select(first, connectionB, 'gemini-high')), { code: 'SETTINGS_CATALOG_CONNECTION_CHANGED' });
  assert.throws(() => selections.validate(select(first, connectionA, 'other-route-low')), { code: 'SETTINGS_CATALOG_MODEL_NOT_FOUND' });
  assert.throws(() => selections.validate(select(second, connectionB, 'gemini-high')), { code: 'SETTINGS_CATALOG_MODEL_NOT_FOUND' });
  assert.throws(() => selections.validate(select(first, connectionA, 'gemini')), { code: 'SETTINGS_CATALOG_MODEL_NOT_FOUND' });
  assert.deepEqual(selections.validate(select(first, connectionA.toUpperCase(), 'gemini-high')), model('gemini-high'));
});

test('grants retain immutable metadata snapshots across input, register output and validate output mutations', () => {
  const selections = new SettingsCatalogSelections();
  const original = model('selected', { reasoningEfforts: ['low', 'high'], capabilities: { tools: { enabled: true } } });
  const expected = structuredClone(original), models = [original];
  const grant = selections.register({ connection: connectionA, models });
  models.splice(0); original.reasoningEfforts.push('max'); original.capabilities.tools.enabled = false;
  grant.models[0].id = 'forged-id'; grant.models[0].reasoningEfforts.length = 0;
  const selected = selections.validate(select(grant, connectionA, 'selected'));
  assert.deepEqual(selected, expected);
  selected.reasoningEfforts.push('max'); selected.capabilities.tools.enabled = false;
  assert.deepEqual(selections.validate(select(grant, connectionA, 'selected')), expected);
  assert.throws(() => selections.validate(select(grant, connectionA, 'forged-id')), { code: 'SETTINGS_CATALOG_MODEL_NOT_FOUND' });
});

test('catalogs preserve incompatible entries for display but those entries cannot be saved', () => {
  const selections = new SettingsCatalogSelections();
  const models = [model('coding'), model('embedding', { compatible: false, compatibilityReason: '专用接口' })];
  const grant = selections.register({ connection: connectionA, models });
  assert.deepEqual(grant.models, models);
  assert.deepEqual(selections.validate(select(grant, connectionA, 'coding')), model('coding'));
  assert.throws(() => selections.validate(select(grant, connectionA, 'embedding')), { code: 'SETTINGS_CATALOG_MODEL_INCOMPATIBLE' });
  assert.throws(() => selections.register({ connection: connectionA, models: [models[1]] }), { code: 'SETTINGS_CATALOG_UNAVAILABLE' });
});

test('empty, malformed or failed catalogs never create a valid selection token', () => {
  const selections = new SettingsCatalogSelections();
  for (const models of [undefined, null, {}, [], [null], [model('')], [model('bad\nmodel')], [model('same'), model('same')],
    [model('bad', { compatible: 'false' })], [model('function', { raw: () => {} })]]) {
    assert.throws(() => selections.register({ connection: connectionA, models }), { code: 'SETTINGS_CATALOG_UNAVAILABLE' });
  }
  assert.throws(() => selections.validate({ selectionToken: 'not-issued', connection: connectionA, model: 'same' }), { code: 'SETTINGS_CATALOG_SELECTION_INVALID' });
});

test('the ten minute deadline is fixed, is inclusive at expiration and is not extended by validation', () => {
  let now = 1792418400000;
  const selections = new SettingsCatalogSelections({ clock: () => now });
  const grant = selections.register({ connection: connectionA, models: [model('chosen')] });
  assert.equal(Date.parse(grant.expiresAt), now + 600000);
  now += 599999;
  assert.equal(selections.validate(select(grant, connectionA, 'chosen')).id, 'chosen');
  now++;
  assert.throws(() => selections.validate(select(grant, connectionA, 'chosen')), { code: 'SETTINGS_CATALOG_SELECTION_EXPIRED' });
  assert.throws(() => selections.validate(select(grant, connectionA, 'chosen')), { code: 'SETTINGS_CATALOG_SELECTION_INVALID' });
});

test('expired grants are pruned before bounded eviction and the oldest live grant is evicted at capacity', () => {
  let now = 1000;
  const selections = new SettingsCatalogSelections({ clock: () => now, ttlMs: 100, maxEntries: 2 });
  const expired = selections.register({ connection: connectionA, models: [model('expired')] });
  now += 50;
  const live = selections.register({ connection: connectionA, models: [model('live')] });
  now += 50;
  const third = selections.register({ connection: connectionB, models: [model('third')] });
  assert.equal(selections.validate(select(live, connectionA, 'live')).id, 'live');
  assert.throws(() => selections.validate(select(expired, connectionA, 'expired')), { code: 'SETTINGS_CATALOG_SELECTION_INVALID' });
  selections.register({ connection: connectionA, models: [model('fourth')] });
  assert.throws(() => selections.validate(select(live, connectionA, 'live')), { code: 'SETTINGS_CATALOG_SELECTION_INVALID' });
  assert.equal(selections.validate(select(third, connectionB, 'third')).id, 'third');
});

test('the production cache retains at most 24 grants and different previews cannot change old snapshots', () => {
  const selections = new SettingsCatalogSelections();
  const grants = [];
  for (let index = 0; index < 25; index++) grants.push(selections.register({ connection: connectionA, models: [model(`model-${index}`)] }));
  assert.throws(() => selections.validate(select(grants[0], connectionA, 'model-0')), { code: 'SETTINGS_CATALOG_SELECTION_INVALID' });
  for (let index = 1; index < grants.length; index++) assert.equal(selections.validate(select(grants[index], connectionA, `model-${index}`)).id, `model-${index}`);
  assert.throws(() => selections.validate(select(grants[24], connectionA, 'model-23')), { code: 'SETTINGS_CATALOG_MODEL_NOT_FOUND' });
});

test('the interface only accepts hashes and errors never echo credentials, tokens, model IDs or connection data', () => {
  const selections = new SettingsCatalogSelections();
  const secret = 'synthetic-private-api-key-never-used';
  for (const connection of [secret, { apiKey: secret }, 'a'.repeat(63), 'z'.repeat(64), null]) {
    assert.throws(() => selections.register({ connection, models: [model('safe')] }), error => {
      assert.equal(error.code, 'SETTINGS_CATALOG_INVALID_CONNECTION');
      assert.doesNotMatch(error.message, /synthetic-private-api-key|apiKey/); return true;
    });
  }
  const grant = selections.register({ connection: connectionA, models: [model('safe')], apiKey: secret });
  for (const args of [null, {}, { selectionToken: secret, connection: connectionA, model: 'safe' },
    select(grant, secret, 'safe'), select(grant, connectionA, secret)]) {
    assert.throws(() => selections.validate(args), error => {
      assert.match(error.message, /模型|目录|连接/);
      assert.doesNotMatch(error.message, new RegExp(`${secret}|${grant.selectionToken}|${connectionA}`)); return true;
    });
  }
  assert.equal(JSON.stringify(selections), '{}');
  assert.doesNotMatch(JSON.stringify(grant), /synthetic-private-api-key|connection|apiKey/);
});

test('clock rollback or failure invalidates prior grants rather than making stale grants appear fresh', () => {
  let now = 5000;
  const selections = new SettingsCatalogSelections({ clock: () => now });
  const grant = selections.register({ connection: connectionA, models: [model('safe')] });
  now--;
  assert.throws(() => selections.validate(select(grant, connectionA, 'safe')), { code: 'SETTINGS_CATALOG_SELECTION_EXPIRED' });
  now = 5000;
  assert.throws(() => selections.validate(select(grant, connectionA, 'safe')), { code: 'SETTINGS_CATALOG_SELECTION_INVALID' });
  const next = selections.register({ connection: connectionA, models: [model('safe')] });
  now = NaN;
  assert.throws(() => selections.validate(select(next, connectionA, 'safe')), { code: 'SETTINGS_CATALOG_SELECTION_EXPIRED' });
  now = 5000;
  assert.throws(() => selections.validate(select(next, connectionA, 'safe')), { code: 'SETTINGS_CATALOG_SELECTION_INVALID' });
});
