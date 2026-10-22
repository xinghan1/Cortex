// Native mouse/keyboard selection in a disposable offscreen child project.
// Batch copy/move uses real IPC and fixture files; no model, host clipboard,
// real recycle bin, command, credential or external service is involved.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { BrowserWindow } = require('electron');

module.exports = async function smokeExplorerSelection({ win, output, dataDir }) {
  assert.equal(win.webContents.isOffscreen(), true, 'Selection smoke requires an isolated parent');
  const fixture = path.join(dataDir, 'explorer-selection-' + randomUUID());
  const project = path.join(fixture, 'first'), second = path.join(fixture, 'second');
  const parentBefore = await win.webContents.executeJavaScript('window.forge.getState()');
  const evidence = {}, screenshots = [];
  let child, stage = 'prepare isolated projects', pointerDown = false;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (label, predicate) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await wait(25); }
    throw new Error('Explorer selection timed out: ' + label);
  };
  const js = code => child.webContents.executeJavaScript(code);
  const call = (method, value) => js(`window.forge[${JSON.stringify(method)}](${value === undefined ? '' : JSON.stringify(value)})`);
  const selector = relative => '.file-row[data-path=' + JSON.stringify(relative) + ']';
  const exists = async filename => { try { await fs.lstat(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
  const idle = () => until('file operations settled', () => js('!fileMutationBusy&&!explorerMovePending&&!editorSaving&&!projectSwitching'));
  const row = relative => until('rendered row ' + relative, () => js(`!!document.querySelector(${JSON.stringify(selector(relative))})`));
  const pointFor = async target => until('uncovered native target ' + target, () => js(`(() => {
    const node=document.querySelector(${JSON.stringify(target)});if(!node||node.disabled||!node.checkVisibility({visibilityProperty:true,opacityProperty:true}))return null;
    node.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
    const r=node.getBoundingClientRect(),p={x:Math.round(r.left+r.width*.55),y:Math.round(r.top+r.height*.5)};
    return r.width&&r.height&&node.contains(document.elementFromPoint(p.x,p.y))?p:null;})()`));
  const click = async (target, modifiers = [], button = 'left') => {
    const point = await pointFor(target); child.webContents.focus();
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) child.webContents.sendInputEvent({ type, ...point, modifiers,
      ...(type === 'mouseMove' ? {} : { button, clickCount: 1 }) });
    await wait(55);
  };
  const key = async (keyCode, modifiers = []) => {
    child.webContents.focus(); child.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    child.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await wait(55);
  };
  const snapshot = () => js(`(() => {
    const tree=$('file-tree'),scroll=document.querySelector('.tree-scroll')||$('files-panel');
    const visible=[...tree.querySelectorAll('.file-row')].filter(n=>n.getClientRects().length);
    const box=document.querySelector('.explorer-selection-box'),r=box?.getBoundingClientRect();
    return {paths:explorerSelection.entries().map(n=>n.path).sort(),marked:[...tree.querySelectorAll('.file-row.selected')].map(n=>n.dataset.path).sort(),
      aria:[...tree.querySelectorAll('.file-row[aria-selected="true"]')].map(n=>n.dataset.path).sort(),multiselect:tree.getAttribute('aria-multiselectable'),
      visible:visible.map(n=>n.dataset.path),editor:selectedPath,focused:document.activeElement?.dataset?.path||null,
      scrollTop:scroll.scrollTop,scrollHeight:scroll.scrollHeight,clientHeight:scroll.clientHeight,
      box:!!box&&!box.hidden&&r.width>0&&r.height>0,drag:!!explorerDrag,native:window.__explorerSelectionSmoke};})()`);
  const selected = async expected => until('selected paths ' + expected.join(', '), async () => {
    const value = await snapshot(), paths = [...expected].sort();
    return JSON.stringify(value.paths) === JSON.stringify(paths) && JSON.stringify(value.marked) === JSON.stringify(paths)
      && JSON.stringify(value.aria) === JSON.stringify(paths) && value;
  });
  const capture = async filename => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        child.webContents.invalidate(); await wait(100 * attempt);
        const image = await child.webContents.capturePage(); assert.equal(image.isEmpty(), false);
        await fs.writeFile(path.join(output, filename), image.toPNG()); screenshots.push(filename); return;
      } catch (error) { if (attempt === 4 || !/UnknownVizError/u.test(String(error?.name) + ' ' + error.message)) throw error; }
    }
  };
  const beginPointer = point => {
    child.webContents.focus(); child.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    child.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point }); pointerDown = true;
  };
  const movePointer = point => child.webContents.sendInputEvent({ type: 'mouseMove', ...point, modifiers: ['leftButtonDown'] });
  const endPointer = async point => {
    child.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point }); pointerDown = false; await wait(80);
  };
  const goProject = async target => {
    await idle(); await js(`openRecentProject({path:${JSON.stringify(target)}})`);
    await until('project active ' + path.basename(target), () => js(`appState?.workspace?.root===${JSON.stringify(target)}&&!projectSwitching&&!fileMutationBusy`));
  };
  const clipboardPaths = value => Array.isArray(value?.paths) ? value.paths : value?.path ? [value.path] : [];
  try {
    await fs.mkdir(output, { recursive: true });
    await fs.mkdir(path.join(project, 'folder'), { recursive: true });
    await fs.mkdir(path.join(project, 'target'), { recursive: true }); await fs.mkdir(second, { recursive: true });
    await Promise.all([
      ...['a.txt', 'b.txt', 'c.txt', 'd.txt'].map(name => fs.writeFile(path.join(project, name), 'SELECTION_' + name + '\n')),
      ...Array.from({ length: 50 }, (_, index) => { const name = `z${String(index).padStart(2, '0')}.txt`; return fs.writeFile(path.join(project, name), 'OVERFLOW_' + index + '\n'); }),
      fs.writeFile(path.join(project, 'folder', 'hidden.txt'), 'FOLDED_CHILD_BYTES\n'), fs.writeFile(path.join(second, 'second.txt'), 'SECOND_PROJECT_BYTES\n'),
    ]);
    child = BrowserWindow.fromId((await win.webContents.executeJavaScript('window.forge.newWindow()')).id);
    assert.ok(child && child !== win && child.webContents.isOffscreen());
    await until('application and selection controller ready', () => js('Boolean(appState&&typeof explorerSelection!=="undefined"&&explorerSelection&&!projectSwitching)'));
    child.setContentSize(1440, 1000); child.setOpacity(0); child.showInactive(); child.webContents.focus();
    await js(`window.__explorerSelectionSmoke={clicks:0,pointerDowns:0,keyDowns:0,dragStarts:0};
      document.addEventListener('click',e=>{if(e.isTrusted&&e.target.closest('#file-tree'))window.__explorerSelectionSmoke.clicks++;},true);
      document.addEventListener('pointerdown',e=>{if(e.isTrusted&&e.target.closest('#file-tree'))window.__explorerSelectionSmoke.pointerDowns++;},true);
      document.addEventListener('keydown',e=>{if(e.isTrusted)window.__explorerSelectionSmoke.keyDowns++;},true);
      document.addEventListener('dragstart',e=>{if(e.isTrusted)window.__explorerSelectionSmoke.dragStarts++;},true);true`);
    await goProject(project); await row('a.txt'); assert.equal((await snapshot()).multiselect, 'true');

    stage = 'Ctrl toggles without opening files or directories';
    const beforeModifiers = await snapshot();
    await click(selector('b.txt'), ['control']); await selected(['b.txt']);
    await click(selector('d.txt'), ['control']); await selected(['b.txt', 'd.txt']);
    await click(selector('b.txt'), ['control']); await selected(['d.txt']);
    assert.equal((await snapshot()).editor, beforeModifiers.editor, 'Modifier clicks opened an editor');
    await click(selector('folder'), ['control']); await selected(['d.txt', 'folder']);
    assert.equal(await js(`document.querySelector(${JSON.stringify(selector('folder'))}).getAttribute('aria-expanded')`), 'false');
    evidence.ctrl = await snapshot();

    stage = 'Shift selects a visible range without changing the open editor';
    await click(selector('a.txt')); await until('ordinary click previews a.txt', () => js("selectedPath==='a.txt'"));
    await click(selector('d.txt'), ['shift']); await selected(['a.txt', 'b.txt', 'c.txt', 'd.txt']);
    assert.equal((await snapshot()).editor, 'a.txt'); await capture('explorer-selection-range.png'); evidence.shift = await snapshot();

    stage = 'Shift arrows select from a stable anchor and Ctrl+A excludes collapsed children';
    await click(selector('a.txt')); await key('Down', ['shift']); await selected(['a.txt', 'b.txt']);
    await key('Down', ['shift']); await selected(['a.txt', 'b.txt', 'c.txt']);
    await key('Up', ['shift']); await selected(['a.txt', 'b.txt']);
    await key('A', ['control']);
    let value = await until('Ctrl+A selects all visible rows', async () => { const item = await snapshot(); return item.paths.length === item.visible.length && item; });
    assert.deepEqual(value.paths, [...value.visible].sort()); assert.equal(value.paths.includes('folder/hidden.txt'), false);
    evidence.keyboard = { allVisible: value.paths.length, hiddenChildExcluded: true };
    await click(selector('folder')); await row('folder/hidden.txt'); await key('A', ['control']);
    value = await snapshot(); assert.equal(value.paths.includes('folder/hidden.txt'), true); assert.deepEqual(value.paths, [...value.visible].sort());
    await click(selector('folder')); assert.equal(await js(`document.querySelector(${JSON.stringify(selector('folder'))}).getAttribute('aria-expanded')`), 'false');

    stage = 'Right click on a selected row and refresh preserve the selection set';
    await click(selector('a.txt')); await click(selector('b.txt'), ['control']); await selected(['a.txt', 'b.txt']);
    await click(selector('b.txt'), [], 'right'); await selected(['a.txt', 'b.txt']);
    assert.equal(await js("!$('file-context-menu').hidden"), true);
    await js('closeFileContextMenu();true');
    await js("$('refresh-files').click();true"); await row('a.txt'); await selected(['a.txt', 'b.txt']); evidence.refreshPreserved = true;

    stage = 'Native long press drag selects rows without file movement or editor changes';
    await js('explorerSelection.clear();true');
    const beforeLong = await snapshot(), start = await pointFor(selector('a.txt'));
    const end = await js(`(() => {const n=document.querySelector(${JSON.stringify(selector('c.txt'))}),r=n.getBoundingClientRect();return {x:Math.round(r.right-8),y:Math.round(r.bottom-2)};})()`);
    beginPointer(start); await wait(440); movePointer({ x: start.x + 5, y: start.y + 5 }); await wait(35); movePointer(end);
    await until('visible long press selection rectangle', async () => (await snapshot()).box);
    await selected(['a.txt', 'b.txt', 'c.txt']); await capture('explorer-selection-long-press.png');
    await endPointer(end); value = await selected(['a.txt', 'b.txt', 'c.txt']);
    assert.equal(value.editor, beforeLong.editor); assert.equal(value.drag, false); assert.equal(value.native.dragStarts, beforeLong.native.dragStarts);
    assert.equal(value.box, false); for (const name of ['a.txt', 'b.txt', 'c.txt']) assert.equal(await exists(path.join(project, name)), true);
    evidence.longPress = { selected: value.paths, nativeMoveStarted: false };

    stage = 'Blank-space drag rectangle selects the final rows';
    await pointFor(selector('z49.txt')); await js("explorerSelection.clear();const scroll=document.querySelector('.tree-scroll')||$('files-panel');scroll.scrollTop=scroll.scrollHeight;true"); await wait(50);
    const blank = await js(`(() => {const tree=$('file-tree'),last=document.querySelector(${JSON.stringify(selector('z49.txt'))}),r=tree.getBoundingClientRect(),l=last.getBoundingClientRect(),scroll=document.querySelector('.tree-scroll')||$('files-panel'),s=scroll.getBoundingClientRect();
      for(let y=Math.ceil(l.bottom+2);y<Math.min(l.bottom+15,s.bottom-2);y++){const p={x:Math.ceil(r.left+3),y},hit=document.elementFromPoint(p.x,p.y);if(hit&&tree.contains(hit)&&!hit.closest('.file-row'))return p;}return null;})()`);
    assert.ok(blank, 'Fixture lacks blank space inside the explorer tree');
    const blankEnd = await js(`(() => {const r=document.querySelector(${JSON.stringify(selector('z47.txt'))}).getBoundingClientRect();return {x:Math.round(r.right-8),y:Math.round(r.top+2)};})()`);
    beginPointer(blank); movePointer(blankEnd); await selected(['z47.txt', 'z48.txt', 'z49.txt']);
    await endPointer(blankEnd); await selected(['z47.txt', 'z48.txt', 'z49.txt']); evidence.blankRectangle = true;

    stage = 'Long-press selection autoscrolls near the explorer edge';
    await js("explorerSelection.clear();(document.querySelector('.tree-scroll')||$('files-panel')).scrollTop=0;true");
    const edgeStart = await pointFor(selector('a.txt'));
    const edge = await js(`(() => {const r=(document.querySelector('.tree-scroll')||$('files-panel')).getBoundingClientRect();return {x:Math.round(r.right-14),y:Math.round(r.bottom-4)};})()`);
    beginPointer(edgeStart); await wait(440); movePointer(edge);
    value = await until('selection edge autoscroll', async () => { const item = await snapshot(); return item.scrollTop > 120 && item.paths.length > 6 && item; });
    await capture('explorer-selection-autoscroll.png'); await endPointer(edge);
    evidence.edgeScroll = { scrollTop: value.scrollTop, selected: value.paths.length };

    stage = 'Escape cancels an in-progress rectangle and clears its overlay';
    await js("(document.querySelector('.tree-scroll')||$('files-panel')).scrollTop=0;explorerSelection.clear();true");
    const cancelStart = await pointFor(selector('a.txt')); beginPointer(cancelStart); await wait(440);
    movePointer({ x: cancelStart.x + 25, y: cancelStart.y + 70 }); await until('rectangle before Escape', async () => (await snapshot()).box);
    await key('Escape'); await until('Escape removes selection rectangle', async () => !(await snapshot()).box);
    await endPointer({ x: cancelStart.x + 25, y: cancelStart.y + 70 }); evidence.escapeCancellation = true;

    stage = 'Native Ctrl+C and Ctrl+V copy both selected files using real IPC';
    await idle(); await click(selector('a.txt')); await click(selector('b.txt'), ['control']); await selected(['a.txt', 'b.txt']);
    await key('C', ['control']);
    await until('two paths in application clipboard', async () => JSON.stringify(clipboardPaths((await call('getState')).fileClipboard).sort()) === JSON.stringify(['a.txt', 'b.txt']));
    await click(selector('target')); await key('V', ['control']);
    await until('both selected files copied', async () => await exists(path.join(project, 'target', 'a.txt')) && await exists(path.join(project, 'target', 'b.txt')));
    await idle();
    for (const name of ['a.txt', 'b.txt']) { const bytes = 'SELECTION_' + name + '\n'; assert.equal(await fs.readFile(path.join(project, name), 'utf8'), bytes); assert.equal(await fs.readFile(path.join(project, 'target', name), 'utf8'), bytes); }
    evidence.batchCopyPaste = true;

    stage = 'An existing drag gesture moves every selected source through real IPC';
    await click(selector('c.txt')); await click(selector('d.txt'), ['control']); await selected(['c.txt', 'd.txt']);
    await js(`(() => {const source=document.querySelector(${JSON.stringify(selector('c.txt'))}),transfer=new DataTransfer();
      const start=new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:transfer});source.dispatchEvent(start);if(start.defaultPrevented)throw new Error('Selected batch drag was rejected');
      const target=document.querySelector(${JSON.stringify(selector('target'))});const over=new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer});target.dispatchEvent(over);if(!over.defaultPrevented)throw new Error('Batch drop target was rejected');
      const drop=new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer});target.dispatchEvent(drop);if(!drop.defaultPrevented)throw new Error('Batch drop was rejected');
      source.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:transfer}));true;})()`);
    await until('both selected files moved', async () => await exists(path.join(project, 'target', 'c.txt')) && await exists(path.join(project, 'target', 'd.txt')) && !(await exists(path.join(project, 'c.txt'))) && !(await exists(path.join(project, 'd.txt'))));
    await idle(); await row('target/d.txt');
    for (const name of ['c.txt', 'd.txt']) assert.equal(await fs.readFile(path.join(project, 'target', name), 'utf8'), 'SELECTION_' + name + '\n');
    evidence.batchMove = true;

    stage = 'Refreshing after an external fixture deletion removes stale selected paths';
    await click(selector('z00.txt')); await click(selector('z01.txt'), ['control']); await selected(['z00.txt', 'z01.txt']);
    await fs.unlink(path.join(project, 'z01.txt'));
    await js("$('refresh-files').click();true"); await row('z00.txt'); await selected(['z00.txt']);
    assert.equal(await js(`!!document.querySelector(${JSON.stringify(selector('z01.txt'))})`), false);
    await fs.writeFile(path.join(project, 'z01.txt'), 'OVERFLOW_1\n'); evidence.externalDeletionReconciled = true;

    stage = 'Switching the project clears old paths and gesture state';
    await goProject(second); await row('second.txt'); value = await selected([]); assert.equal(value.box, false); assert.equal(value.drag, false);
    await click(selector('second.txt'), ['control']); await selected(['second.txt']);
    await goProject(project); await row('a.txt'); value = await selected([]); assert.equal(value.box, false);
    await capture('explorer-selection-completed.png'); evidence.workspaceIsolation = true;
    assert.ok(value.native.pointerDowns >= 16 && value.native.clicks >= 12 && value.native.keyDowns >= 8, 'Expected genuine Chromium mouse and keyboard input');
    const parentAfter = await win.webContents.executeJavaScript('window.forge.getState()');
    assert.equal(parentAfter.workspace?.root, parentBefore.workspace?.root); assert.equal(parentAfter.sessionId, parentBefore.sessionId);
    const result = { status: 'completed', realApi: false, realCommands: false, isolatedChildProject: true,
      nativeCtrlToggle: true, nativeShiftRange: true, modifierClicksDoNotOpen: true, nativeShiftArrowsAndSelectAll: true,
      foldedChildrenExcluded: true, expandedChildrenIncluded: true, selectedContextRetained: true, refreshSelectionRetained: true,
      nativeLongPressRectangle: true, nativeBlankRectangle: true, longPressDoesNotMoveFiles: true, nativeEdgeAutoscroll: true,
      escapeCancelsRectangle: true, actualBatchCopyPaste: true, actualBatchDragMove: true, workspaceSelectionIsolation: true,
      externalDeletionReconciled: true,
      parentWorkspacePreserved: true, hostClipboardUntouched: true, realRecycleBinUntouched: true, evidence, screenshots };
    await fs.writeFile(path.join(output, 'explorer-selection-result.json'), JSON.stringify(result, null, 2) + '\n'); return result;
  } catch (error) {
    const result = { status: 'failed', stage, error: error.message, stack: error.stack, evidence };
    if (child && !child.isDestroyed()) { result.snapshot = await snapshot().catch(() => null); await capture('explorer-selection-failure.png').catch(() => {}); }
    await fs.writeFile(path.join(output, 'explorer-selection-result.json'), JSON.stringify(result, null, 2) + '\n'); throw error;
  } finally {
    if (child && !child.isDestroyed()) {
      if (pointerDown) child.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: 10, y: 10 });
      await js('explorerSelection?.cancelGesture();closeFileContextMenu();clearExplorerDrag();true').catch(() => {}); child.destroy();
    }
  }
};
