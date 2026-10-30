// Exercises the actual renderer, preload IPC and remote service without recording credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
module.exports = async function smokeMobileRemote({ win, output }) {
  const js = code => win.webContents.executeJavaScript(code);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (label, predicate) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { if (await predicate()) return; await wait(30); }
    throw new Error('Mobile remote smoke timed out: ' + label);
  };
  try {
    await until('renderer initialized', () => js(`typeof appState !== 'undefined' && !!appState && !projectSwitching && !restoringWorkspace`));
    await js(`document.getElementById('menu-settings').click()`);
    await until('settings menu', () => js(`!!document.querySelector('#app-menu-popup [data-action="mobile-remote"]')`));
    await js(`document.querySelector('#app-menu-popup [data-action="mobile-remote"]').click()`);
    await until('status loaded', () => js(`document.getElementById('mobile-remote-dialog').open && !document.getElementById('mobile-remote-start').disabled`));
    await js(`document.getElementById('mobile-remote-start').click()`);
    await until('service started', () => js(`!document.getElementById('mobile-remote-stop').disabled && !document.getElementById('mobile-remote-info').hidden`));
    await until('QR rendered', () => js(`!document.getElementById('mobile-remote-qr').hidden && !document.getElementById('mobile-remote-qr-image').hidden && document.getElementById('mobile-remote-qr-image').width > 100`));
    const displayed = await js(`(() => {const a=document.getElementById('mobile-remote-addresses').textContent, f=document.getElementById('mobile-remote-fingerprint').textContent, t=document.getElementById('mobile-remote-token').textContent;return {address: a.includes('https://'), fingerprint: /^[0-9A-F:]{95}$/i.test(f), token: t.length >= 32};})()`);
    assert.deepEqual(displayed, { address: true, fingerprint: true, token: true });
    await js(`document.getElementById('mobile-remote-dialog').close()`);
    await until('credentials cleared on close', () => js(`document.getElementById('mobile-remote-token').textContent === '' && document.getElementById('mobile-remote-qr-image').width === 1`));
    assert.equal(await js(`window.forge.mobileRemoteStatus().then(s => s.enabled)`), true);
    await js(`window.CortexMobileRemote.open()`);
    await until('status reloaded', () => js(`!document.getElementById('mobile-remote-stop').disabled`));
    await until('QR reloaded', () => js(`!document.getElementById('mobile-remote-qr-image').hidden`));
    // Replace credentials with obviously fake values before capturing a preview.
    await js(`document.getElementById('mobile-remote-qr').hidden=true;const c=document.getElementById('mobile-remote-qr-image');c.width=1;c.height=1;c.hidden=true;document.getElementById('mobile-remote-addresses').textContent='https://192.168.1.8:34567';document.getElementById('mobile-remote-fingerprint').textContent='AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';document.getElementById('mobile-remote-token').textContent='EXAMPLE-TOKEN-FOR-PREVIEW';`);
    await fs.mkdir(output, {recursive: true}); win.webContents.invalidate(); await wait(200);
    await fs.writeFile(path.join(output, 'mobile-remote-dialog.png'), (await win.webContents.capturePage()).toPNG());
    await js(`document.getElementById('mobile-remote-stop').click()`);
    await until('service stopped', () => js(`!document.getElementById('mobile-remote-start').disabled && document.getElementById('mobile-remote-info').hidden`));
    return { menu: true, enabled: true, credentialsDisplayed: true, closeKeepsService: true, stopped: true, screenshot: 'mobile-remote-dialog.png' };
  } finally { await js(`window.forge.mobileRemoteStop()`); }
};
