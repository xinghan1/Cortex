import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installBrowserContextMenu } from '../src/core/browser-context-menu.cjs';

function fixture() {
  const contents = new EventEmitter(), calls = []; let version = 0, valid = true, template, popped = 0;
  contents.isDestroyed = () => false; contents.focus = () => calls.push('focus');
  for (const name of ['copy','cut','paste','delete','undo','redo','selectAll']) contents[name] = () => calls.push(name);
  contents.executeJavaScriptInIsolatedWorld = async (_world, scripts) => scripts[0].code.includes('?.valid()') ? valid : true;
  const window = { isDestroyed: () => false }, Menu = { buildFromTemplate(value) { template = value; return { popup() { popped++; } }; } };
  const dispose = installBrowserContextMenu({ contents, window, Menu, isCurrent: () => true, getPageVersion: () => version });
  async function open(params) { let prevented = false; await contents.listeners('context-menu')[0]({ preventDefault() { prevented = true; } }, { x: 20, y: 30, ...params }); return prevented; }
  return { open, calls, dispose, menu: () => template, popped: () => popped, navigate: () => version++, invalidate: () => { valid = false; } };
}

test('selected page text has copy and select all using native editing commands', async () => {
  const f = fixture(); assert.equal(await f.open({ editFlags: { canCopy: true, canSelectAll: true } }), true);
  assert.deepEqual(f.menu().map(item => item.label), ['复制','全选']); await f.menu()[0].click(); assert.deepEqual(f.calls, ['focus','copy']);
});

test('editable text includes paste and refuses changed or navigated targets', async () => {
  const f = fixture(); await f.open({ isEditable: true, editFlags: { canPaste: true, canCopy: true } });
  const paste = f.menu().find(item => item.label === '粘贴'); assert.equal(paste.enabled, true);
  f.invalidate(); await paste.click(); assert.deepEqual(f.calls, []);
  const g = fixture(); await g.open({ isEditable: true, editFlags: { canPaste: true } }); const previous = g.menu().find(item => item.label === '粘贴');
  g.navigate(); await previous.click(); assert.deepEqual(g.calls, []);
});

test('password inputs never open the menu and disposed views cannot act', async () => {
  const f = fixture(); assert.equal(await f.open({ isEditable: true, inputFieldType: 'password', editFlags: { canPaste: true } }), false); assert.equal(f.popped(), 0);
  await f.open({ isEditable: true, editFlags: { canPaste: true } }); const paste = f.menu().find(item => item.label === '粘贴'); f.dispose(); await paste.click(); assert.deepEqual(f.calls, []);
});
