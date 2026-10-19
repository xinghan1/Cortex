import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const { resolveDataDirectory } = createRequire(import.meta.url)('../src/core/data-path.cjs');
const options = {
  isPackaged: true,
  isInstalled: true,
  appDataPath: path.resolve('synthetic-profile', 'AppData', 'Roaming'),
  execPath: path.resolve('synthetic-install', 'Synora code.exe'),
  projectDir: path.resolve('synthetic-source'),
};

test('installer data stays in the user profile across upgrades and install directory changes', () => {
  const expected = path.join(options.appDataPath, 'Synora code');
  assert.equal(resolveDataDirectory(options), expected);
  assert.equal(resolveDataDirectory({ ...options, execPath: path.resolve('another-install', 'Synora code.exe') }), expected);
  assert.equal(resolveDataDirectory({ ...options, smoke: true }), expected);
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
