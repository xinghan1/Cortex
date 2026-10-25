const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');

// Installs from the actual ASAR and starts the disclosed compatibility program with
// an empty home. No login, session creation, account files or inference.
module.exports = async function smokeOfficialRuntime({ runtime, dataDir }) {
  const { killAntigravityProcessTree } = await import('./antigravity-agent.mjs');
  const installed = await runtime.ensure(), home = path.join(dataDir, 'runtime-probe-home'), work = path.join(home, 'work');
  await fs.mkdir(work, { recursive: true }); await fs.writeFile(path.join(work, '.env'), '');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:path|pathext|systemroot|windir|comspec|temp|tmp|lang|lc_all)$/iu.test(key)));
  Object.assign(env, { HOME: home, USERPROFILE: home, ZCODE_HOME: path.join(home, '.zcode'),
    ZCODE_DATA_BASE_DIR: home, ZCODE_STORAGE_DIR: path.join(home, '.zcode'), ZCODE_RUNTIME_ENV: 'production', SYNORA_ZCODE_STANDALONE_ACCOUNT: '1' });
  let child, timer;
  try {
    const capabilities = await new Promise((resolve, reject) => {
      let buffer = '';
      child = spawn(installed.entry, ['app-server'], { cwd: work, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      timer = setTimeout(() => reject(new Error('Original runtime capabilities timed out.')), 30000);
      child.stderr.resume(); child.once('error', reject); child.once('exit', () => reject(new Error('Original runtime exited before capabilities.')));
      child.stdout.on('data', bytes => {
        buffer += bytes.toString(); if (buffer.length > 1024 * 1024) return reject(new Error('Runtime response too large.'));
        let split; while ((split = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, split); buffer = buffer.slice(split + 1); if (!line.trim()) continue;
          let response; try { response = JSON.parse(line); } catch { return reject(new Error('Invalid original runtime response.')); }
          if (response.id === 1) {
            if (response.error || Object.hasOwn(response, 'jsonrpc')) return reject(new Error('Unexpected original wire protocol.'));
            return resolve(response.result);
          }
        }
      });
      child.stdin.write(JSON.stringify({ id: 1, method: 'runtime/capabilities', params: {} }) + '\n');
    });
    assert.equal(capabilities.independentPlanState, true); assert.equal(capabilities.historyFirst, true);
    assert.equal((await runtime.publicState()).status, 'ready');
    return { status: 'completed', sourceBuiltVersion: installed.version, compatibilityComponentInitialized: true, standaloneAccountEnabled: true,
      asarRuntimeCopyVerified: true, capabilities, authenticateRequested: false, sessionCreated: false, inferenceRequests: 0 };
  } finally { clearTimeout(timer); await killAntigravityProcessTree(child); }
};
