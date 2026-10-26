const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');

// Empty app-owned homes only: --help plus Ark's no-browser Phase 1. This checks
// the real packaged CLI contract without completing OAuth or requesting a model.
module.exports = async function smokeAccountRuntime({ claudeRuntime, arkAccount, dataDir }) {
  const { killAntigravityProcessTree } = await import('./antigravity-agent.mjs');
  const { arkAuthorizationUrl } = await import('./ark-account.mjs');
  const results = [];
  for (const [name, runtime] of [['claude', claudeRuntime], ['ark', arkAccount]]) {
    const installed = await runtime.ensure();
    assert.equal(path.isAbsolute(installed.entry), true);
    assert.doesNotMatch(installed.entry, /\.asar[\\/]/u, 'Native executables must be outside the ASAR archive.');
    const home = path.join(dataDir, 'account-runtime-probe', name);
    await fs.mkdir(home, { recursive: true });
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:path|pathext|systemroot|windir|comspec|temp|tmp|lang|lc_all)$/iu.test(key)));
    Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'), CLAUDE_CONFIG_DIR: path.join(home, 'claude'), CI: '1' });
    async function probe(args) {
      let child, timer;
      try {
        return await new Promise((resolve, reject) => {
          let count = 0, output = '';
          child = spawn(installed.entry, [...(installed.args || []), ...args], { cwd: home, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
          timer = setTimeout(() => reject(new Error(`${name} runtime probe timed out.`)), 20000);
          child.once('error', reject);
          for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { count += data.length; if (count > 2 * 1024 * 1024) reject(new Error('Runtime probe response too large.')); });
          child.stdout.on('data', data => { output += data.toString('utf8'); });
          child.once('close', code => code === 0 && count > 0 ? resolve({ count, output }) : reject(new Error(`${name} runtime probe failed.`)));
        });
      } finally { clearTimeout(timer); await killAntigravityProcessTree(child); }
    }
    const help = await probe(['--help']);
    const result = { name, version: installed.version, status: 'ready', helpBytes: help.count, helpExecuted: true };
    if (name === 'ark') {
      const initialization = await probe(['auth', 'login', '--login-mode', 'legacy', '--no-browser']);
      let pending; try { pending = JSON.parse(initialization.output); } catch { throw new Error('Native Ark did not return pending authorization JSON.'); }
      assert.equal(pending.stage, 'authorize_pending'); assert.equal(pending.method, 'sso_no_browser');
      arkAuthorizationUrl(pending.authorize_url);
      result.crossDeviceAuthorizationInitialized = true;
      result.authorizationHost = new URL(pending.authorize_url).hostname;
      result.browserOpened = false; result.authorizationCompleted = false;
    }
    results.push(result);
  }
  return { components: results, realOAuth: false, inferenceRequests: 0, isolatedHomes: true };
};
