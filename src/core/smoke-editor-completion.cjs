// All edits and native keyboard/pointer input target an isolated child window
// and disposable fixture files. No model, terminal, command, or user data runs.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { BrowserWindow } = require('electron');

module.exports = async function smokeEditorCompletion({ win, output, dataDir }) {
  assert.equal(win.webContents.isOffscreen(), true);
  const project = path.join(dataDir, 'editor-completion-' + randomUUID());
  const fixtures = [
    { file: 'sample.py', before: '# Isolated completion fixture\n', prefix: 'pri', label: /^print$/, expected: /\bprint\s*\(/ },
    { file: 'Sample.java', before: 'class Sample {\n  void test() {\n    ', after: '\n  }\n}\n', prefix: 'sout', label: /sout|println/, expected: /System\.out\.println\s*\(/ },
    { file: 'Sample.cs', before: 'class Sample {\n  void Test() {\n    Console.', after: '\n  }\n}\n', prefix: 'Wr', label: /WriteLine/, expected: /Console\.WriteLine\s*\(/ },
    { file: 'sample.cpp', before: '#include <iostream>\nint main() {\n  std::', after: '\n}\n', prefix: 'co', label: /^cout$/, expected: /std::cout\b/ },
    { file: 'sample.c', before: '#include <stdio.h>\nint main(void) {\n  ', after: '\n}\n', prefix: 'pri', label: /^printf$/, expected: /\bprintf\s*\(/ },
    { file: 'sample.html', before: '<main>\n  <', after: '\n</main>\n', prefix: 'di', label: /^div$/, expected: /<div\b/ },
    { file: 'sample.css', before: 'body {\n  ', after: '\n}\n', prefix: 'col', label: /^color$/, expected: /\bcolor\s*:/ },
    { file: 'sample.js', before: 'function sample() {\n  console.', after: '\n}\n', prefix: 'lo', label: /^log$/, expected: /console\.log\s*\(/ },
  ];
  let child, stage = 'create isolated fixtures';
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (label, predicate) => {
    const end = Date.now() + 15000;
    while (Date.now() < end) { const value = await predicate(); if (value) return value; await wait(25); }
    throw new Error('Editor completion smoke timed out: ' + label);
  };
  const js = code => child.webContents.executeJavaScript(code);
  const inspect = () => js(`(() => {
    const editor=$('file-content'),host=editor.closest('.file-code-editor'),list=$('editor-completion-list');
    return {path:selectedPath,value:editor.value,start:editor.selectionStart,end:editor.selectionEnd,
      active:document.activeElement===editor,readOnly:editor.readOnly,dirty:editorDirty,saving:editorSaving,
      list:{exists:Boolean(list),hidden:!list||list.hidden,role:list?.getAttribute('role'),
        options:list?[...list.querySelectorAll('.editor-completion-option')].map(item=>({label:item.querySelector('.completion-label')?.textContent||item.textContent,
          role:item.getAttribute('role'),selected:item.getAttribute('aria-selected')==='true',id:item.id})):[]},
      activeDescendant:editor.getAttribute('aria-activedescendant'),
      mirror:$('file-highlight-code').textContent.replace(/\u200b$/,''),highlighted:host.classList.contains('syntax-ready'),
      lines:Number($('file-line-numbers')?.dataset.totalLines),scrollTop:editor.scrollTop};
  })()`);
  const key = async (keyCode, modifiers = []) => {
    child.webContents.focus();
    // Electron's input API names navigation accelerators Down/Up; the DOM
    // receives standard ArrowDown/ArrowUp keys from these native events.
    const nativeKey = ({ ArrowDown: 'Down', ArrowUp: 'Up' })[keyCode] || keyCode;
    child.webContents.sendInputEvent({ type: 'keyDown', keyCode: nativeKey, modifiers });
    child.webContents.sendInputEvent({ type: 'keyUp', keyCode: nativeKey, modifiers });
    await wait(35);
  };
  const open = async (relative, caret = null) => {
    await js(`previewFile(${JSON.stringify(relative)})`);
    await until('editable file ' + relative, () => js(`selectedPath===${JSON.stringify(relative)}&&!$('file-content').readOnly&&!$('file-preview').hidden`));
    await until('file visual revision ' + relative, async () => {
      const value = await inspect();
      return value.path === relative && value.lines === value.value.split('\n').length
        && (!value.highlighted || value.mirror === value.value) && value.list.hidden;
    });
    await js(`(() => {const editor=$('file-content');editor.focus();const at=${caret === null ? 'editor.value.length' : String(caret)};editor.setSelectionRange(at,at);editor.scrollTop=0;editor.scrollLeft=0;})()`);
    child.webContents.focus();
  };
  const saved = async relative => until('autosave ' + relative, async () => {
    const value = await inspect();
    return !value.dirty && !value.saving && await fs.readFile(path.join(project, relative), 'utf8') === value.value && value;
  });
  const popup = async label => until('completion popup ' + label, async () => {
    const state = await inspect();
    return !state.list.hidden && state.list.options.length > 0 && state;
  });
  const selectLabel = async matcher => {
    let state = await popup(String(matcher));
    assert.equal(state.list.role, 'listbox');
    assert.ok(state.list.options.every(item => item.role === 'option'));
    const target = state.list.options.findIndex(item => matcher.test(item.label));
    assert.ok(target >= 0, `Expected ${matcher} in ${JSON.stringify(state.list.options)}`);
    const active = state.list.options.findIndex(item => item.selected);
    assert.ok(active >= 0, 'An open list must expose its selected completion');
    for (let step = 0; step < (target - active + state.list.options.length) % state.list.options.length; step++) await key('ArrowDown');
    state = await inspect();
    assert.match(state.list.options.find(item => item.selected)?.label || '', matcher);
    assert.equal(state.activeDescendant, state.list.options.find(item => item.selected)?.id, 'The textarea should announce its selected option');
    assert.equal(state.active, true, 'Arrow navigation must keep native editing focus');
    return state;
  };
  const capture = async name => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        child.webContents.invalidate(); await wait(attempt * 150);
        const image = await child.webContents.capturePage(); assert.equal(image.isEmpty(), false);
        await fs.writeFile(path.join(output, name), image.toPNG()); return;
      } catch (error) { if (!/UnknownVizError/.test(String(error)) || attempt === 4) throw error; }
    }
  };
  try {
    await fs.mkdir(project, { recursive: true }); await fs.mkdir(output, { recursive: true });
    for (const fixture of fixtures) await fs.writeFile(path.join(project, fixture.file), fixture.before + (fixture.after || ''));
    await fs.writeFile(path.join(project, 'middle.js'), 'const untouched = 1;\nconsole.gger(); // keep this suffix\n');
    await fs.writeFile(path.join(project, 'comments.py'), '# ');
    await fs.writeFile(path.join(project, 'strings.js'), 'const value = "');
    await fs.writeFile(path.join(project, 'plain.txt'), 'Plain file\n');
    await fs.writeFile(path.join(project, 'keyboard.js'), '');
    await fs.writeFile(path.join(project, 'snippet.py'), '');
    await fs.writeFile(path.join(project, 'nested.html'), '');
    await fs.writeFile(path.join(project, 'Newline.java'), '');
    const created = await win.webContents.executeJavaScript('window.forge.newWindow()');
    child = BrowserWindow.fromId(created.id); assert.ok(child && child !== win && child.webContents.isOffscreen());
    await until('child completion renderer', () => js('Boolean(appState&&window.ForgeEditorCompletion&&window.ForgeCompletion&&!projectSwitching)'));
    child.setContentSize(1440, 1000); child.setOpacity(0); child.showInactive(); child.webContents.focus();
    await js(`openRecentProject({path:${JSON.stringify(project)}})`);
    await until('isolated project active', () => js(`appState?.workspace?.root===${JSON.stringify(project)}&&!projectSwitching`));

    const languages = [];
    for (const fixture of fixtures) {
      stage = 'native completion ' + fixture.file;
      await open(fixture.file, fixture.before.length);
      await child.webContents.insertText(fixture.prefix);
      await selectLabel(fixture.label);
      if (!languages.length) await capture('editor-completion-popup.png');
      await key('Tab');
      let state = await until('accepted ' + fixture.file, async () => { const value = await inspect(); return fixture.expected.test(value.value) && value; });
      assert.ok(state.value.startsWith(fixture.before), 'Completion must preserve preceding source');
      if (fixture.after) assert.ok(state.value.endsWith(fixture.after), 'Completion must preserve following source');
      assert.equal(state.active, true); assert.equal(state.list.hidden, true);
      assert.doesNotMatch(state.value, /\$\{\d+(?::[^}]*)?\}/, 'Snippet markers must not become source');
      state = await saved(fixture.file);
      await until('accepted source mirrors and line numbers ' + fixture.file, async () => {
        const value = await inspect(); return value.lines === value.value.split('\n').length && (!value.highlighted || value.mirror === value.value);
      });
      languages.push(fixture.file);
      await key('Escape');
    }

    stage = 'nested HTML completion within a snippet body';
    await open('nested.html'); await child.webContents.insertText('<di');
    await selectLabel(/^div$/); await key('Tab');
    assert.equal((await inspect()).value, '<div></div>');
    await child.webContents.insertText('<sp'); await selectLabel(/^span$/); await key('Tab');
    let state = await saved('nested.html');
    assert.equal(state.value, '<div><span></span></div>', 'A body placeholder should allow completing a nested HTML tag');

    stage = 'replace complete token at a middle caret';
    const middleSource = await fs.readFile(path.join(project, 'middle.js'), 'utf8');
    await open('middle.js', middleSource.indexOf('console.') + 'console.'.length);
    await child.webContents.insertText('lo');
    await selectLabel(/^log$/); await key('Tab');
    state = await saved('middle.js');
    assert.match(state.value, /^const untouched = 1;\nconsole\.log\(\); \/\/ keep this suffix\n$/);
    assert.ok(!state.value.includes('logger'), 'A completion must replace the word suffix to the right of the caret');
    await key('z', ['control']);
    await until('native completion undo', async () => (await inspect()).value.includes('console.logger();'));
    await saved('middle.js');

    stage = 'escape and manual completion';
    await open('keyboard.js'); await key('Space', ['control']);
    state = await popup('explicit empty document');
    assert.ok(state.list.options.length >= 2, 'Explicit completion should offer choices in an empty supported file');
    const firstSelected = state.list.options.find(item => item.selected)?.label;
    await js(`window.__completionNativeKeys=[];$('file-content').addEventListener('keydown',event=>window.__completionNativeKeys.push({key:event.key,code:event.code,trusted:event.isTrusted}),true)`);
    await key('ArrowDown'); state = await inspect();
    assert.equal(await js(`window.__completionNativeKeys.at(-1)?.key`), 'ArrowDown', 'Native test input must deliver an actual DOM ArrowDown key');
    assert.equal(await js(`window.__completionNativeKeys.at(-1)?.trusted`), true);
    assert.notEqual(state.list.options.find(item => item.selected)?.label, firstSelected, 'Native ArrowDown must move through choices');
    await key('ArrowUp'); state = await inspect();
    assert.equal(state.list.options.find(item => item.selected)?.label, firstSelected, 'Native ArrowUp must return to the previous choice');
    await key('Escape'); await child.webContents.insertText('console.lo');
    await selectLabel(/^log$/); await key('Escape');
    state = await inspect(); assert.equal(state.list.hidden, true); assert.equal(state.value, 'console.lo');
    await key('Space', ['control']); await selectLabel(/^log$/); await key('Enter');
    state = await saved('keyboard.js'); assert.match(state.value, /console\.log\s*\(/); assert.equal(state.list.hidden, true);
    await capture('editor-completion-accepted.png');

    stage = 'native pointer accepts completion';
    await open('sample.css');
    await js(`(() => {const editor=$('file-content');editor.setSelectionRange(0,editor.value.length);})()`);
    await child.webContents.insertText('body {\n  col\n}\n');
    await js(`(() => {const editor=$('file-content');const at=editor.value.indexOf('col')+3;editor.setSelectionRange(at,at);})()`);
    await key('Space', ['control']); await selectLabel(/^color$/);
    const point = await js(`(() => {const item=[...$('editor-completion-list').querySelectorAll('.editor-completion-option')].find(item=>item.querySelector('.completion-label')?.textContent==='color');const r=item.getBoundingClientRect();const point={x:Math.round(r.left+Math.min(60,r.width/2)),y:Math.round(r.top+r.height/2)};if(!item.contains(document.elementFromPoint(point.x,point.y)))throw new Error('Completion pointer target is covered');return point;})()`);
    child.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    child.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    child.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    state = await saved('sample.css'); assert.match(state.value, /\bcolor\s*:/); assert.equal(state.active, true);

    stage = 'snippet placeholder navigation and replacement';
    await open('snippet.py'); await child.webContents.insertText('def');
    await selectLabel(/^def$/); await key('Tab');
    state = await inspect();
    assert.match(state.value, /^def\s+/); assert.ok(state.end > state.start, 'The first snippet placeholder must be selected');
    const first = { start: state.start, end: state.end, text: state.value.slice(state.start, state.end) };
    await key('Tab'); state = await inspect();
    assert.ok(state.start > first.end && state.end > state.start, 'Tab must select the next editable placeholder');
    const second = { start: state.start, end: state.end };
    await key('Tab', ['shift']); state = await inspect();
    assert.equal(state.start, first.start); assert.equal(state.end, first.end, 'Shift+Tab must return to the previous placeholder');
    await child.webContents.insertText('native_function');
    await key('Tab'); state = await inspect();
    assert.ok(state.start > second.start, 'Later placeholder offsets must follow native replacement length changes');
    assert.ok(state.end > state.start, 'A typed placeholder must preserve navigation to the next stop');
    await key('Tab'); state = await inspect();
    assert.ok(state.end > state.start, 'The Python function template should select its body placeholder');
    await child.webContents.insertText('return 42'); await key('Tab');
    state = await saved('snippet.py');
    assert.match(state.value, /^def native_function\(/); assert.match(state.value, /return 42/);
    assert.equal(state.start, state.end, 'The final snippet stop should restore a normal collapsed caret');
    assert.equal(state.list.hidden, true);

    stage = 'native newline in an empty Java body placeholder';
    await open('Newline.java'); await child.webContents.insertText('main');
    await selectLabel(/^main$/); await key('Tab');
    state = await inspect();
    assert.match(state.value, /public static void main\(String\[\] args\)/);
    assert.equal(state.start, state.end, 'An empty snippet body should start with a collapsed editable stop');
    const bodyStart = state.start, bodySource = state.value;
    await child.webContents.insertText('\n'); await key('Tab');
    state = await saved('Newline.java');
    assert.equal(state.value, bodySource.slice(0, bodyStart) + '\n' + bodySource.slice(bodyStart), 'Tab after a body newline must navigate rather than inject indentation');
    assert.equal(state.start, state.value.length, 'The final snippet stop must follow a newline inserted next to an existing newline');
    assert.equal(state.end, state.value.length);

    stage = 'comments strings and unsupported files remain native';
    for (const [relative, prefix] of [['comments.py', 'pri'], ['strings.js', 'console.lo'], ['plain.txt', 'pri']]) {
      await open(relative); await child.webContents.insertText(prefix); await wait(300);
      state = await inspect(); assert.equal(state.list.hidden, true, relative + ' must not show irrelevant automatic suggestions');
      await saved(relative);
    }
    await open('plain.txt', 0); await key('Tab');
    state = await saved('plain.txt'); assert.ok(state.value.startsWith('  Plain'), 'Without a completion Tab should retain two-space indentation');

    stage = 'composition never accepts a stale completion';
    await open('keyboard.js');
    await js(`(() => {const editor=$('file-content');editor.setSelectionRange(0,editor.value.length);})()`);
    await child.webContents.insertText('console.lo'); await selectLabel(/^log$/);
    await js(`$('file-content').dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}))`);
    state = await inspect(); assert.equal(state.list.hidden, true);
    const beforeCompositionTab = state.value;
    await js(`$('file-content').dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',code:'Tab',isComposing:true,bubbles:true,cancelable:true}))`);
    assert.equal((await inspect()).value, beforeCompositionTab, 'A composing Tab must not commit a completion or inject indentation');
    await js(`$('file-content').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:''}))`);
    await saved('keyboard.js');

    stage = 'file change read-only and scrolling clear the list';
    await key('Space', ['control']); await popup('before file switch');
    await open('sample.py'); assert.equal((await inspect()).list.hidden, true);
    await child.webContents.insertText('\npri'); await selectLabel(/^print$/);
    await js(`$('file-content').scrollTop=1;$('file-content').dispatchEvent(new Event('scroll'))`);
    assert.equal((await inspect()).list.hidden, true);
    await key('Space', ['control']); await popup('before read-only');
    await js(`$('file-content').readOnly=true`);
    await until('read-only hides suggestions', async () => (await inspect()).list.hidden);
    await key('Space', ['control']); assert.equal((await inspect()).list.hidden, true);
    await js(`$('file-content').readOnly=false`); await saved('sample.py');

    const result = { status: 'completed', realApi: false, realCommands: false, isolatedFilesOnly: true,
      nativeTextarea: true, languages, nativeTyping: true, nativeArrowSelection: true, nativeTabAndEnterAccept: true,
      nativePointerAccept: true, nativeCompletionUndo: true, explicitControlSpace: true, escapeDismiss: true,
      caretMiddleReplacesSuffix: true, preservesAdjacentSource: true, autosaveAndDecorations: true,
      commentsStringsAndUnsupportedSuppression: true, indentationFallback: true, readOnlyAndFileSwitchDismiss: true,
      scrollDismiss: true, programmaticCaretSetup: true, syntheticCompositionCoverage: true,
      snippetPlaceholderTabAndShiftTab: true, snippetOffsetsTrackNativeTyping: true,
      nestedHtmlSnippetCompletion: true,
      nativeEmptyPlaceholderNewlineNavigation: true,
      screenshots: ['editor-completion-popup.png', 'editor-completion-accepted.png'] };
    await fs.writeFile(path.join(output, 'editor-completion-smoke-result.json'), JSON.stringify(result, null, 2) + '\n');
    return result;
  } catch (error) {
    const failure = { status: 'failed', stage, error: error.message, stack: error.stack };
    if (child && !child.isDestroyed()) { try { failure.editor = await inspect(); await capture('editor-completion-failure.png'); } catch (diagnostic) { failure.diagnosticError = diagnostic.message; } }
    await fs.writeFile(path.join(output, 'editor-completion-smoke-result.json'), JSON.stringify(failure, null, 2) + '\n');
    throw new Error('Editor completion smoke failed at ' + stage + ': ' + error.message, { cause: error });
  } finally {
    if (child && !child.isDestroyed()) {
      try { await js(`$('file-content').readOnly=false`); } catch {}
      child.close(); await until('isolated completion child closed', () => child.isDestroyed());
    }
  }
};
