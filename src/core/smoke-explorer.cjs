// Actual explorer/editor UI against isolated local files. Host Explorer, clipboard and recycle bin are fully stubbed.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { BrowserWindow, dialog, shell, clipboard } = require('electron');

module.exports = async function smokeExplorer({ win, output, dataDir }) {
  const js = code => win.webContents.executeJavaScript(code);
  const call = (method, arg) => js(`window.forge[${JSON.stringify(method)}](${arg === undefined ? '' : JSON.stringify(arg)})`);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (label, predicate) => {
    for (let attempt = 0; attempt < 160; attempt++) {
      const value = await predicate();
      if (value) return value;
      await wait(25);
    }
    throw new Error('Explorer smoke timed out: ' + label);
  };
  const identity = value => path.normalize(value).replace(/[\\/]+$/u, '').toLowerCase();
  const rendererReady = label => until(label, () => js('!projectSwitching&&!fileMutationBusy&&!editorSaving'));
  const projectReady = (label, target, expectedSession) => until(label, async () => {
    const main = await call('getState');
    const rendered = await js('({root:appState?.workspace?.root,sessionId,projectSwitching,fileMutationBusy,editorSaving})');
    return identity(main.workspace?.root || '') === identity(target)
      && identity(rendered.root || '') === identity(target)
      && !rendered.projectSwitching && !rendered.fileMutationBusy && !rendered.editorSaving
      && (!expectedSession || (main.sessionId === expectedSession && rendered.sessionId === expectedSession));
  });
  const taskDir = path.join(dataDir, 'explorer-fixture-' + randomUUID());
  const first = path.join(taskDir, 'project-one');
  const second = path.join(taskDir, 'project-two');
  const outside = path.join(taskDir, 'outside');
  const recycle = path.join(taskDir, 'test-recycle-bin');
  const originals = { open: dialog.showOpenDialog, message: dialog.showMessageBox, trash: shell.trashItem, reveal: shell.showItemInFolder, copy: clipboard.writeText, rename: fs.rename, fileOpen: fs.open, fileRead: fs.readFile };
  const copied = [], trashed = [], confirmations = [], revealed = [];
  let deleteApproved = false;
  let otherWindow;
  let releaseSaveGate;
  let releaseCreateGate;
  const readText = relative => fs.readFile(path.join(first, relative), 'utf8');
  const exists = async absolute => { try { await fs.lstat(absolute); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
  const rowSelector = relative => '.file-row[data-path=' + JSON.stringify(relative) + ']';
  const row = relative => until('tree row ' + relative, () => js(`!!document.querySelector(${JSON.stringify(rowSelector(relative))})`));
  const refresh = async () => { await rendererReady('renderer ready to refresh'); await js("document.getElementById('refresh-files').click()"); await row('README.md'); };
  const context = async (relative, action) => {
    await rendererReady('renderer ready for ' + action);
    if (relative !== null) await row(relative);
    await js(`(()=>{
      const target=${relative === null ? "document.getElementById('file-tree')" : `document.querySelector(${JSON.stringify(rowSelector(relative))})`};
      const rect=target.getBoundingClientRect();
      target.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:rect.left+12,clientY:rect.top+12}));
      const button=document.querySelector('#file-context-menu [data-file-action=${JSON.stringify(action)}]');
      if(!button||button.disabled)throw new Error('Explorer action unavailable: '+${JSON.stringify(action)});
      if(${JSON.stringify(action)}==='reveal'&&button.querySelector('.app-menu-label')?.textContent!=='打开文件所在位置')throw new Error('Reveal menu label differs from requested text');
      button.click();
    })()`);
    if (action === 'paste' || action === 'delete') await rendererReady(action + ' renderer operation finished');
  };
  const openFile = async relative => {
    await rendererReady('renderer ready to open ' + relative);
    await row(relative);
    await js(`document.querySelector(${JSON.stringify(rowSelector(relative))}).click()`);
    await until('editor opens ' + relative, () => js(`document.getElementById('preview-filename').title===${JSON.stringify(relative)}&&!document.getElementById('file-preview').hidden`));
    await rendererReady('editor open finished ' + relative);
  };
  const nameDialog = async name => {
    await until('file name dialog', () => js("document.getElementById('file-name-dialog').open"));
    await js(`(()=>{const input=document.getElementById('file-name-input');input.value=${JSON.stringify(name)};input.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('file-name-form').requestSubmit();})()`);
    await until('file name accepted', () => js("!document.getElementById('file-name-dialog').open"));
    await rendererReady('named file operation finished');
  };
  const setEditor = content => js(`(()=>{const input=document.getElementById('file-content');if(input.readOnly)throw new Error('Editor is read-only');input.value=${JSON.stringify(content)};input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();})()`);
  const rejected = async (method, arg) => {
    const result = await js(`(async()=>{try{await window.forge[${JSON.stringify(method)}](${JSON.stringify(arg)});return false;}catch{return true;}})()`);
    assert.equal(result, true, method + ' accepted an unsafe or conflicting operation');
  };
  const capture = async name => { win.webContents.invalidate(); await wait(100); await fs.writeFile(path.join(output, name), (await win.webContents.capturePage()).toPNG()); };
  try {
    assert.equal(path.dirname(path.resolve(taskDir)).toLowerCase(), path.resolve(dataDir).toLowerCase());
    assert.ok(path.basename(taskDir).startsWith('explorer-fixture-'));
    await fs.mkdir(path.join(first, 'nested', 'inner'), { recursive: true });
    await fs.mkdir(path.join(first, 'target'));
    await fs.mkdir(path.join(first, 'blocked', 'nested'), { recursive: true });
    await fs.mkdir(second); await fs.mkdir(outside); await fs.mkdir(recycle);
    await fs.writeFile(path.join(first, 'README.md'), 'Explorer fixture README\n');
    await fs.writeFile(path.join(first, 'other.txt'), 'Other editor fixture\n');
    await fs.writeFile(path.join(first, 'large-binary.bin'), Buffer.alloc(512 * 1024 + 17));
    await fs.writeFile(path.join(first, 'nested', 'inner', 'value.txt'), 'nested original\n');
    await fs.writeFile(path.join(first, 'blocked', 'nested', 'sentinel.txt'), 'must not overwrite\n');
    await fs.writeFile(path.join(second, 'second.txt'), 'Second project\n');
    await fs.writeFile(path.join(outside, 'sentinel.txt'), 'outside preserved\n');
    const sessions = path.join(dataDir, 'sessions');
    await fs.mkdir(sessions, { recursive: true });
    const history = async (workspace, text, offset, empty = false) => {
      const id = randomUUID();
      await fs.writeFile(path.join(sessions, id + '.json'), JSON.stringify({ id, title: 'fixture history', updatedAt: new Date(Date.now() + offset).toISOString(), workspace, messages: empty ? [] : [{ role: 'user', content: text }, { role: 'assistant', content: 'Local fixture history reply.' }], events: [], demo: false, usageLedgerVersion: 1 }));
      return id;
    };
    const oldMarker = 'EXPLORER_OLDER_' + randomUUID();
    const markerA = 'EXPLORER_PROJECT_A_' + randomUUID();
    const markerB = 'EXPLORER_PROJECT_B_' + randomUUID();
    await history(first, oldMarker, -60_000);
    const firstSession = await history(first, markerA, -30_000);
    await history(first, '', -10_000, true);
    const secondSession = await history(second, markerB, -20_000);
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [first] });
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      assert.match(String(options.title || '') + ' ' + String(options.message || ''), /删除|回收/u, 'Unexpected native confirmation in explorer smoke');
      confirmations.push(options);
      return { response: deleteApproved ? 0 : 1 };
    };
    clipboard.writeText = text => { copied.push(text); };
    shell.showItemInFolder = absolute => {
      assert.equal(typeof absolute, 'string');
      assert.ok(path.isAbsolute(absolute));
      const relative = path.relative(path.resolve(first), path.resolve(absolute));
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Reveal target left the isolated project');
      revealed.push(absolute);
    };
    shell.trashItem = async absolute => {
      const resolved = path.resolve(absolute), relative = path.relative(path.resolve(first), resolved);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Trash target left the isolated project');
      const destination = path.join(recycle, randomUUID() + '-' + path.basename(resolved));
      await fs.rename(resolved, destination);
      trashed.push({ source: resolved, destination });
    };

    // Open from the actual project menu, then return through its recent/history entry.
    await js("document.getElementById('project-switcher').click();document.getElementById('project-open').click()");
    await projectReady('first project and latest meaningful history', first, firstSession);
    await until('first history rendered', () => js(`document.getElementById('messages').innerText.includes(${JSON.stringify(markerA)})`));
    assert.ok(!(await js("document.getElementById('messages').innerText")).includes(oldMarker));
    await call('openProject', { path: second });
    await projectReady('second history restored', second, secondSession);
    await js("document.getElementById('project-switcher').click()");
    const dropdown = await js(`(()=>{const identity=value=>String(value).replace(/[\\\\/]+$/u,'').replace(/\\//gu,'\\\\').toLowerCase();return [...document.querySelectorAll('#project-dropdown .recent-project')].map(item=>({path:identity(item.dataset.workspace),name:item.querySelector('strong')?.textContent,history:!!item.querySelector('.project-history-badge')}));})()`);
    for (const project of [first, second]) {
      const entries = dropdown.filter(item => item.path === identity(project));
      assert.equal(entries.length, 1);
      assert.equal(entries[0].name, path.basename(project));
      assert.equal(entries[0].history, true);
    }
    await capture('explorer-projects.png');
    await js(`(()=>{const item=[...document.querySelectorAll('#project-dropdown .recent-project')].find(item=>item.dataset.workspace===${JSON.stringify(first)});if(!item||item.disabled)throw new Error('Recent project entry unavailable');item.click();})()`);
    await projectReady('recent project restored first history', first, firstSession);
    await until('history marker restored', () => js(`document.getElementById('messages').innerText.includes(${JSON.stringify(markerA)})`));
    await row('README.md');

    // Revealing only resolves a safe path: binary/large files and folders need no text reader.
    const revealTargets = ['README.md', 'nested', 'large-binary.bin'];
    const revealOnlyFiles = new Set(revealTargets.map(relative => identity(path.join(first, relative))));
    const assertNotReadingRevealTarget = absolute => {
      if (typeof absolute === 'string' && revealOnlyFiles.has(identity(absolute))) throw new Error('Reveal must not read file contents');
    };
    fs.open = async (absolute, ...rest) => { assertNotReadingRevealTarget(absolute); return originals.fileOpen(absolute, ...rest); };
    fs.readFile = async (absolute, ...rest) => { assertNotReadingRevealTarget(absolute); return originals.fileRead(absolute, ...rest); };
    try {
      for (const relative of revealTargets) {
        const count = revealed.length;
        await context(relative, 'reveal');
        await until('reveals ' + relative, () => revealed.length === count + 1);
        assert.equal(identity(revealed.at(-1)), identity(path.join(first, relative)));
      }
    } finally { fs.open = originals.fileOpen; fs.readFile = originals.fileRead; }
    assert.equal(await js(`(()=>{
      const target=document.getElementById('file-tree');const rect=target.getBoundingClientRect();
      target.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:rect.left+12,clientY:rect.top+12}));
      const button=document.querySelector('#file-context-menu [data-file-action="reveal"]');
      const disabled=!!button&&button.disabled;button?.click();closeFileContextMenu();return disabled;
    })()`), true, 'Blank-area reveal must be disabled');
    assert.equal(revealed.length, revealTargets.length);
    for (const input of ['../outside/sentinel.txt', path.join(outside, 'sentinel.txt'), 'missing.txt']) {
      await rejected('fileReveal', { path: input });
      assert.equal(revealed.length, revealTargets.length, 'Unsafe or missing path reached host Explorer');
    }

    // Create through the toolbar/dialog and persist edits without pressing Save or Ctrl+S.
    await rendererReady('renderer ready to create folder');
    await js("document.getElementById('new-folder').click()");
    await nameDialog('created-folder');
    await until('created folder exists', () => exists(path.join(first, 'created-folder')));
    await row('created-folder');
    await context(null, 'new-file');
    await nameDialog('draft.txt');
    await until('draft opened', () => js("document.getElementById('preview-filename').title==='draft.txt'&&!document.getElementById('file-preview').hidden"));
    await rendererReady('new draft editor ready');
    const draft = 'const value = 1;\n// 保存测试\n';
    await setEditor(draft);
    assert.equal(await js("document.getElementById('editor-dirty').hidden"), false);
    await until('input automatically persisted', async () => await readText('draft.txt') === draft);
    await until('editor clean after automatic save', () => js("document.getElementById('editor-dirty').hidden&&!editorSaving"));
    assert.match(await js("document.getElementById('editor-status').textContent"), /已自动保存/u);
    const rapid = 'Rapid input final buffer\n';
    await js(`(()=>{const input=document.getElementById('file-content');for(const content of ['Rapid input one','Rapid input two',${JSON.stringify(rapid)}]){input.value=content;input.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
    await until('rapid edits persist final buffer', async () => await readText('draft.txt') === rapid);
    await until('rapid edits become clean', () => js("document.getElementById('editor-dirty').hidden&&!editorSaving"));

    // Delay only the atomic replacement of this one fixture file, proving the next input arrives in-flight.
    let gateEntered = false;
    const saveGate = new Promise(resolve => { releaseSaveGate = resolve; });
    fs.rename = async (source, destination) => {
      if (!gateEntered && typeof source === 'string' && typeof destination === 'string' && path.basename(source).startsWith('.manual-save-') && identity(destination) === identity(path.join(first, 'draft.txt'))) {
        gateEntered = true;
        await saveGate;
      }
      return originals.rename(source, destination);
    };
    const duringSave = 'Input received while the previous save is in flight\n';
    try {
      await setEditor('First in-flight save buffer\n');
      await until('fixture save is in flight', () => gateEntered);
      assert.equal(await js("document.getElementById('file-content').readOnly"), false, 'Saving locked the textarea');
      await setEditor(duringSave);
      assert.equal(await js("document.getElementById('editor-dirty').hidden"), false);
      releaseSaveGate();
      await until('in-flight edits are saved after the earlier response', async () => await readText('draft.txt') === duringSave);
      await until('latest in-flight buffer is clean', () => js("document.getElementById('editor-dirty').hidden&&!editorSaving"));
      assert.equal(await js("document.getElementById('file-content').value"), duringSave);
    } finally {
      releaseSaveGate();
      fs.rename = originals.rename;
    }

    // Ctrl+S remains an immediate-save shortcut, while ordinary navigation flushes its pending debounce.
    const manual = 'Immediate Ctrl+S fixture\n';
    await setEditor(manual);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'S', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'S', modifiers: ['control'] });
    await until('Ctrl+S persisted editor text', async () => await readText('draft.txt') === manual);
    await until('editor clean after save', () => js("document.getElementById('editor-dirty').hidden&&!editorSaving"));
    const fileSwitch = 'Saved before switching files\n';
    await setEditor(fileSwitch);
    await openFile('README.md');
    assert.equal(await readText('draft.txt'), fileSwitch);
    assert.equal(await js("document.getElementById('editor-unsaved-dialog').open"), false);
    await openFile('draft.txt');
    const projectSwitch = 'Saved before switching projects\n';
    await setEditor(projectSwitch);
    await js(`(()=>{document.getElementById('project-switcher').click();const item=[...document.querySelectorAll('#project-dropdown .recent-project')].find(item=>item.dataset.workspace===${JSON.stringify(second)});if(!item||item.disabled)throw new Error('Project switch unavailable before auto-save flush');item.click();})()`);
    await projectReady('project switch flushes pending input', second, secondSession);
    assert.equal(await readText('draft.txt'), projectSwitch);
    assert.equal(await js("document.getElementById('editor-unsaved-dialog').open"), false);
    await js(`(()=>{document.getElementById('project-switcher').click();const item=[...document.querySelectorAll('#project-dropdown .recent-project')].find(item=>item.dataset.workspace===${JSON.stringify(first)});if(!item||item.disabled)throw new Error('First recent project unavailable');item.click();})()`);
    await projectReady('first project restored after flush', first, firstSession);
    await openFile('draft.txt');

    // A real external version conflict pauses automatic saves and is what makes the dirty guard necessary.
    const stale = await call('fileRead', { path: 'draft.txt' });
    assert.match(stale.version, /^[a-f0-9]{64}$/iu);
    await rejected('fileSave', { path: 'draft.txt', content: 'must not save without version' });
    assert.equal(await readText('draft.txt'), projectSwitch);
    const external = 'External concurrent edit\n';
    await fs.writeFile(path.join(first, 'draft.txt'), external);
    await rejected('fileSave', { path: 'draft.txt', content: 'must not overwrite concurrent edit', expectedVersion: stale.version });
    assert.equal(await readText('draft.txt'), external);
    await setEditor('Unsaved editor fixture\n');
    await until('automatic save conflict is paused', () => js("!document.getElementById('editor-dirty').hidden&&document.getElementById('editor-status').textContent.includes('自动保存已暂停')"));
    assert.equal(await readText('draft.txt'), external);
    assert.equal(await js("document.getElementById('file-content').value"), 'Unsaved editor fixture\n');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'S', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'S', modifiers: ['control'] });
    await until('manual retry also respects external version', () => js("!editorSaving&&document.getElementById('editor-status').textContent.includes('自动保存已暂停')"));
    assert.equal(await readText('draft.txt'), external);
    await js(`document.querySelector(${JSON.stringify(rowSelector('README.md'))}).click()`);
    await until('dirty guard dialog', () => js("document.getElementById('editor-unsaved-dialog').open"));
    await js("document.getElementById('editor-unsaved-cancel').click()");
    assert.equal(await js("document.getElementById('preview-filename').title"), 'draft.txt');
    assert.equal(await js("document.getElementById('file-content').value"), 'Unsaved editor fixture\n');
    await js(`document.querySelector(${JSON.stringify(rowSelector('README.md'))}).click()`);
    await until('dirty guard reopened', () => js("document.getElementById('editor-unsaved-dialog').open"));
    await js("document.getElementById('editor-unsaved-discard').click()");
    await until('discard opens README', () => js("document.getElementById('preview-filename').title==='README.md'&&document.getElementById('file-content').value==='Explorer fixture README\\n'"));
    assert.equal(await readText('draft.txt'), external);
    const pane = await js(`(()=>{const panel=document.getElementById('preview-panel').getBoundingClientRect();return{pinned:document.documentElement.classList.contains('preview-pinned'),editor:document.documentElement.classList.contains('file-editor-open'),left:panel.left,right:panel.right,width:panel.width,viewport:innerWidth,textarea:document.getElementById('file-content').tagName};})()`);
    assert.ok(pane.pinned && pane.editor && pane.left > pane.viewport / 2 && pane.right <= pane.viewport + 1 && pane.width >= 280);
    assert.equal(pane.textarea, 'TEXTAREA');
    await capture('explorer-editor.png');

    // Copy and cut a nested folder through the real context menu, and reject overwrite conflicts.
    await context('nested', 'copy');
    await until('copy buffer enables paste', () => js("!!fileClipboard&&fileClipboard.mode==='copy'"));
    await context(null, 'paste');
    await until('nested same-folder copy', () => exists(path.join(first, 'nested - 副本', 'inner', 'value.txt')));
    assert.equal(await readText('nested - 副本/inner/value.txt'), 'nested original\n');
    assert.equal(await readText('nested/inner/value.txt'), 'nested original\n');
    await context('nested - 副本', 'cut');
    await until('cut buffer available', () => js("!!fileClipboard&&fileClipboard.mode==='cut'"));
    await context('target', 'paste');
    await until('cut moved nested copy', () => exists(path.join(first, 'target', 'nested - 副本', 'inner', 'value.txt')));
    assert.equal(await exists(path.join(first, 'nested - 副本')), false);
    assert.equal(await readText('target/nested - 副本/inner/value.txt'), 'nested original\n');
    await call('fileClipboard', { path: 'nested', mode: 'cut' });
    await rejected('filePaste', { destination: 'blocked' });
    assert.equal(await readText('nested/inner/value.txt'), 'nested original\n');
    assert.equal(await readText('blocked/nested/sentinel.txt'), 'must not overwrite\n');

    // Rename in the tree, cancel deletion of the edited file, then move it into the fake recycle bin.
    await context('draft.txt', 'rename'); await nameDialog('renamed.txt');
    await until('rename completed', () => exists(path.join(first, 'renamed.txt')));
    assert.equal(await exists(path.join(first, 'draft.txt')), false);
    assert.equal(await readText('renamed.txt'), external);
    await openFile('renamed.txt');
    await context('renamed.txt', 'delete');
    await until('delete confirmation cancelled', () => confirmations.length === 1);
    await until('cancelled deletion UI settled', () => js("!fileMutationBusy"));
    assert.equal(await exists(path.join(first, 'renamed.txt')), true);
    assert.equal(trashed.length, 0);
    assert.equal(await js("document.getElementById('preview-filename').title"), 'renamed.txt');
    assert.equal(await js("document.getElementById('file-content').value"), external);
    assert.equal(await js("document.getElementById('file-preview').hidden"), false);
    deleteApproved = true;
    await context('renamed.txt', 'delete');
    await until('file moved to test recycle bin', () => trashed.length === 1);
    assert.equal(await exists(path.join(first, 'renamed.txt')), false);
    assert.equal(await fs.readFile(trashed[0].destination, 'utf8'), external);
    await until('deleted editor cleared', () => js("document.getElementById('file-preview').hidden"));

    // Path copying uses the fake clipboard; unsafe calls must neither escape nor reach the recycle bin.
    await context('README.md', 'copy-relative-path');
    await until('relative path copied', () => copied.length === 1);
    assert.equal(copied[0], 'README.md');
    await context('README.md', 'copy-path');
    await until('absolute path copied', () => copied.length === 2);
    assert.equal(identity(copied[1]), identity(path.join(first, 'README.md')));
    for (const [method, arg] of [
      ['fileList', { path: '../outside' }], ['fileRead', { path: '../outside/sentinel.txt' }],
      ['fileCreate', { parent: '../outside', name: 'escape.txt', type: 'file' }],
      ['fileRename', { path: '../outside/sentinel.txt', name: 'escaped.txt' }],
      ['fileDelete', { path: '' }], ['fileDelete', { path: '.' }], ['fileDelete', { path: '../outside/sentinel.txt' }],
      ['fileClipboard', { path: '../outside/sentinel.txt', mode: 'copy' }],
      ['filePaste', { destination: '../outside' }], ['fileCopyPath', { path: '../outside/sentinel.txt', relative: false }],
    ]) await rejected(method, arg);
    assert.equal(trashed.length, 1);
    assert.equal(confirmations.length, 2);
    assert.equal(copied.length, 2);
    assert.deepEqual(await fs.readdir(outside), ['sentinel.txt']);
    assert.equal(await fs.readFile(path.join(outside, 'sentinel.txt'), 'utf8'), 'outside preserved\n');

    // Closing a separate test window flushes unsaved input and leaves the original window running.
    const child = await call('newWindow');
    otherWindow = BrowserWindow.fromId(child.id);
    assert.ok(otherWindow && otherWindow !== win);
    await otherWindow.webContents.executeJavaScript(`window.forge.openProject({path:${JSON.stringify(first)}})`);
    await until('close-flush file row ready', () => otherWindow.webContents.executeJavaScript(`!!document.querySelector(${JSON.stringify(rowSelector('other.txt'))})`));
    await otherWindow.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(rowSelector('other.txt'))}).click()`);
    await until('close-flush editor ready', () => otherWindow.webContents.executeJavaScript("document.getElementById('preview-filename').title==='other.txt'&&!document.getElementById('file-preview').hidden"));
    const closeContent = 'Saved while closing the fixture window\n';
    await otherWindow.webContents.executeJavaScript(`(()=>{const input=document.getElementById('file-content');input.value=${JSON.stringify(closeContent)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    otherWindow.webContents.executeJavaScript('window.forge.closeWindow()').catch(() => {});
    await until('test window closes after flushing input', () => otherWindow.isDestroyed());
    assert.equal(await readText('other.txt'), closeContent);
    assert.equal(win.isDestroyed(), false);

    // Even a clean editor must keep its window alive until an already-started file operation finishes.
    const operationChild = await call('newWindow');
    otherWindow = BrowserWindow.fromId(operationChild.id);
    assert.ok(otherWindow && otherWindow !== win);
    await otherWindow.webContents.executeJavaScript(`window.forge.openProject({path:${JSON.stringify(first)}})`);
    let createGateEntered = false;
    const createGate = new Promise(resolve => { releaseCreateGate = resolve; });
    fs.open = async (absolute, flags, ...rest) => {
      if (!createGateEntered && typeof absolute === 'string' && identity(absolute) === identity(path.join(first, 'close-pending.txt')) && typeof flags === 'number' && (flags & constants.O_CREAT) && (flags & constants.O_EXCL)) {
        createGateEntered = true;
        await createGate;
      }
      return originals.fileOpen(absolute, flags, ...rest);
    };
    try {
      assert.equal(await otherWindow.webContents.executeJavaScript('editorDirty||editorSaving'), false);
      await otherWindow.webContents.executeJavaScript(`(()=>{window.__closePendingCreate=window.forge.fileCreate({parent:'',name:'close-pending.txt',type:'file'}).then(()=>true,()=>false);return true;})()`);
      await until('clean-window file create is in flight', () => createGateEntered);
      otherWindow.webContents.executeJavaScript('window.forge.closeWindow()').catch(() => {});
      await wait(80);
      assert.equal(otherWindow.isDestroyed(), false, 'Clean window closed before its pending file operation completed');
      releaseCreateGate();
      await until('pending create completes before window closes', async () => await exists(path.join(first, 'close-pending.txt')) && otherWindow.isDestroyed());
      assert.equal(await readText('close-pending.txt'), '');
      assert.equal(win.isDestroyed(), false);
    } finally {
      releaseCreateGate();
      fs.open = originals.fileOpen;
    }
    await refresh(); await openFile('README.md');
    await capture('explorer-files.png');
    return { status: 'completed', realApi: false, projectDropdown: true, latestMeaningfulHistory: true, multipleProjects: true, revealLocation: true, binaryAndDirectoryRevealWithoutReading: true, blankRevealDisabled: true, hostExplorerStubbed: revealed.length, createFileAndFolder: true, automaticSave: true, rapidInputSaved: true, inFlightInputRetained: true, fileSwitchFlush: true, projectSwitchFlush: true, windowCloseFlush: true, cleanWindowWaitsForFileOperation: true, editorCtrlS: true, expectedVersionRequired: true, concurrentEditsProtected: true, conflictPausesAndRetainsBuffer: true, dirtyCancelAndDiscard: true, rightEditorPane: true, nestedCopyAndCut: true, cutConflictProtected: true, rename: true, deleteCancelPreservesEditor: true, fakeRecycleBin: trashed.length, clipboardStubbed: copied.length, rootAndTraversalRejected: true, screenshots: ['explorer-projects.png', 'explorer-editor.png', 'explorer-files.png'] };
  } catch (error) {
    const renderer = win.isDestroyed() ? null : await js('({root:appState?.workspace?.root,sessionId,projectSwitching,fileMutationBusy,editorSaving,editorDirty,status:document.getElementById("editor-status").textContent})').catch(() => null);
    console.error('EXPLORER_SMOKE_DIAGNOSTIC', JSON.stringify({ error: error.message, copied: copied.length, trashed: trashed.length, confirmations: confirmations.length, renderer }));
    throw error;
  } finally {
    releaseSaveGate?.();
    releaseCreateGate?.();
    fs.rename = originals.rename;
    fs.open = originals.fileOpen;
    fs.readFile = originals.fileRead;
    if (otherWindow && !otherWindow.isDestroyed()) otherWindow.destroy();
    dialog.showOpenDialog = originals.open;
    dialog.showMessageBox = originals.message;
    shell.trashItem = originals.trash;
    shell.showItemInFolder = originals.reveal;
    clipboard.writeText = originals.copy;
  }
};
