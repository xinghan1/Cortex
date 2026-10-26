const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');

// Start only --help with empty, app-owned homes. This checks executable paths
// after ASAR packaging without authenticating or sending a model request.
module.exports = async function smokeAccountRuntime({ claudeRuntime, arkAccount, dataDir }) {
  const { killAntigravityProcessTree } = await import('./antigravity-agent.mjs');
  const results = [];
  for (const [name, runtime] of [['claude', claudeRuntime], ['ark', arkAccount]]) {
    const installed = await runtime.ensure();
    assert.equal(path.isAbsolute(installed.entry), true);
    assert.doesNotMatch(installed.entry, /\.asar[\\/]/u, 'Native executables must be outside the ASAR archive.');
    const home = path.join(dataDir, 'account-runtime-probe', name);
    await fs.mkdir(home, { recursive: true });
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:path|pathext|systemroot|windir|comspec|temp|tmp|lang|lc_all)$/iu.test(key)));
    Object.assign(env, { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, 'claude'), CI: '1' });
    let child, timer;
    try {
      const bytes = await new Promise((resolve, reject) => {
        let count = 0;
        child = spawn(installed.entry, [...(installed.args || []), '--help'], { cwd: home, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        timer = setTimeout(() => reject(new Error(`${name} runtime help timed out.`)), 20000);
        child.once('error', reject);
        for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
          count += data.length; if (count > 2 * 1024 * 1024) reject(new Error('Runtime help response too large.'));
        });
        child.once('close', code => code === 0 && count > 0 ? resolve(count) : reject(new Error(`${name} runtime help failed.`)));
      });
      results.push({ name, version: installed.version, status: 'ready', helpBytes: bytes, helpExecuted: true });
    } finally { clearTimeout(timer); await killAntigravityProcessTree(child); }
  }
  return { components: results, realOAuth: false, inferenceRequests: 0, isolatedHomes: true };
};
