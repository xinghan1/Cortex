import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';

const { resolveDataDirectory, migrateInstalledProfile } = createRequire(import.meta.url)('../src/core/data-path.cjs');
const options = {
  isPackaged: true,
  isInstalled: true,
  appDataPath: path.resolve('synthetic-profile', 'AppData', 'Roaming'),
  execPath: path.resolve('synthetic-install', 'Synora code.exe'),
  projectDir: path.resolve('synthetic-source'),
};

test('installer data stays in the user profile across upgrades and install directory changes', () => {
  const expected = path.join(options.appDataPath, 'Cortex');
  assert.equal(resolveDataDirectory(options), expected);
  assert.equal(resolveDataDirectory({ ...options, execPath: path.resolve('another-install', 'Synora code.exe') }), expected);
  assert.equal(resolveDataDirectory({ ...options, smoke: true }), expected);
});

test('old installer profile is copied in full before use, preserving the old data and existing Cortex data', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-migration-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const old = path.join(root, 'Synora code'), target = path.join(root, 'Cortex');
  fs.mkdirSync(path.join(old, 'chromium'), { recursive: true });
  fs.mkdirSync(path.join(old, 'official-agents', 'kimi'), { recursive: true });
  fs.writeFileSync(path.join(old, 'chromium', 'Local State'), 'protected state');
  fs.writeFileSync(path.join(old, 'official-agents', 'kimi', 'profile'), 'account state');
  assert.equal(migrateInstalledProfile(root), true);
  assert.equal(fs.readFileSync(path.join(target, 'chromium', 'Local State'), 'utf8'), 'protected state');
  assert.equal(fs.readFileSync(path.join(target, 'official-agents', 'kimi', 'profile'), 'utf8'), 'account state');
  fs.writeFileSync(path.join(old, 'official-agents', 'kimi', 'profile'), 'new old data');
  assert.equal(migrateInstalledProfile(root), false);
  assert.equal(fs.readFileSync(path.join(target, 'official-agents', 'kimi', 'profile'), 'utf8'), 'account state');
  assert.equal(fs.readFileSync(path.join(old, 'official-agents', 'kimi', 'profile'), 'utf8'), 'new old data');
});

test('failed installer migration leaves no partial Cortex profile', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-migration-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'Synora code'), 'not a directory');
  assert.throws(() => migrateInstalledProfile(root), /旧版数据目录/);
  assert.equal(fs.existsSync(path.join(root, 'Cortex')), false);
  assert.equal(fs.readFileSync(path.join(root, 'Synora code'), 'utf8'), 'not a directory');
});

test('installer migration rejects links without publishing partial data', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-migration-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const old = path.join(root, 'Synora code'), external = path.join(root, 'external');
  fs.mkdirSync(old); fs.mkdirSync(external);
  fs.writeFileSync(path.join(old, 'settings.json'), '{}');
  fs.symlinkSync(external, path.join(old, 'linked'), 'junction');
  assert.throws(() => migrateInstalledProfile(root), /符号链接/);
  assert.equal(fs.existsSync(path.join(root, 'Cortex')), false);
  assert.deepEqual(fs.readdirSync(root).sort(), ['Synora code', 'external']);
});

test('portable builds keep their adjacent data directory and never share installer credentials implicitly', () => {
  const expected = path.join(path.dirname(options.execPath), 'data');
  assert.equal(resolveDataDirectory({ ...options, isInstalled: false }), expected);
  assert.notEqual(expected, resolveDataDirectory(options));
});

test('source and smoke modes stay local even when installer metadata is present', () => {
  assert.equal(resolveDataDirectory({ ...options, isPackaged: false }), path.join(options.projectDir, '.local-data'));
  assert.equal(resolveDataDirectory({ ...options, isPackaged: false, smoke: true }), path.join(options.projectDir, '.smoke-data-v16-6'));
});

test('explicit isolated data directories take precedence for all build modes', () => {
  const override = path.resolve('synthetic-smoke-data');
  for (const isPackaged of [false, true]) for (const isInstalled of [false, true]) {
    assert.equal(resolveDataDirectory({ ...options, override, isPackaged, isInstalled }), override);
  }
});
