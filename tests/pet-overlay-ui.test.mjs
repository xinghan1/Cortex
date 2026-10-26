import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../src/renderer/pet-overlay.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((pass, fail) => { resolve = pass; reject = fail; }); return { promise, resolve, reject }; };
class Target {
  constructor() { this.listeners = new Map(); }
  addEventListener(name, listener) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(listener); }
  removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); }
  emit(name, event = {}) { for (const listener of this.listeners.get(name) || []) listener({ type: name, preventDefault() {}, ...event }); }
}
class Element extends Target {
  constructor(tag, document) {
    super(); this.tag = tag; this.document = document; this.children = []; this.attributes = {}; this.dataset = {}; this.style = {};
    this.hidden = false; this.textContent = ''; this.playCount = 0; this.pauseCount = 0; this.loadCount = 0;
    this.classes = new Set(); this.classList = { add: value => this.classes.add(value), remove: value => this.classes.delete(value) };
  }
  set id(value) { this._id = value; if (value) this.document.elements.set(value, this); }
  get id() { return this._id; }
  set innerHTML(_) { throw new Error('Pet settings cannot render HTML'); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; if (name === 'src') this.src = ''; }
  focus() { this.document.activeElement = this; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  play() { ++this.playCount; return Promise.resolve(); }
  pause() { ++this.pauseCount; }
  load() { ++this.loadCount; }
  setPointerCapture(id) { this.pointer = id; }
  hasPointerCapture(id) { return this.pointer === id; }
  releasePointerCapture() { this.pointer = null; }
  getBoundingClientRect() {
    if (this.bounds) return this.bounds;
    const left = parseFloat(this.style.left || 0), top = parseFloat(this.style.top || 0), width = parseFloat(this.style.width || 160), height = parseFloat(this.style.height || 250);
    return { left, top, width, height, right: left + width, bottom: top + height };
  }
  remove() { this.removed = true; }
}
const categories = ['idle', 'clicks', 'drag', 'turn', 'actions', 'thinking', 'working', 'result', 'waiting', 'success', 'error'];
const state = overrides => ({ enabled: true, size: 220, x: 1, y: 1, workStatus: true, packId: 'dsh-pet',
  packs: [{ id: 'dsh-pet', name: '帝师猴', animations: Object.fromEntries(categories.map(kind => [kind, [{ name: kind, url: `file:///D:/app/pet/${kind}.webm` }]])) }], ...overrides });
function fixture({ initial = state(), methods = {}, reduced = false, composerTop, gazeEnabled = false } = {}) {
  const document = new Target(); document.elements = new Map(); document.hidden = false;
  document.createElement = tag => new Element(tag, document); document.body = new Element('body', document);
  document.getElementById = id => document.elements.get(id);
  document.querySelector = selector => selector === '.composer-area' ? document.elements.get('composer-area') : null;
  const view = new Target(), motion = new Target(); view.innerWidth = 1000; view.innerHeight = 800; motion.matches = reduced;
  const frames = new Map(); let nextFrame = 0;
  view.requestAnimationFrame = callback => { const id = ++nextFrame; frames.set(id, callback); return id; };
  view.cancelAnimationFrame = id => frames.delete(id);
  const observers = [];
  view.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
    observe(target) { this.targets.add(target); }
    disconnect() { this.disconnected = true; this.targets.clear(); }
  };
  if (composerTop !== undefined) {
    for (const id of ['composer-area', 'task-form', 'composer-approval']) {
      const node = new Element('section', document); node.id = id;
      node.bounds = { top: composerTop, bottom: 780, left: 200, right: 980, width: 780, height: 780 - composerTop };
      node.hidden = id === 'composer-approval'; document.body.append(node);
    }
  }
  view.matchMedia = () => motion; document.defaultView = view;
  view.CustomEvent = class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } };
  view.dispatchEvent = event => view.emit(event.type, event);
  const gaze = { active: false, points: [], destroyed: false };
  const ForgePetGaze = gazeEnabled ? { create: options => {
    gaze.options = options;
    return { setActive(value) { gaze.active = value; return value; }, point(value) { gaze.points.push(value && plain(value)); }, destroy() { gaze.destroyed = true; } };
  } } : undefined;
  const context = vm.createContext({ document, ForgePetGaze }); vm.runInContext(source, context);
  const calls = [], notices = [], configured = []; let current = initial; const events = new Set();
  const bridge = {
    petState(...args) { calls.push(['petState', plain(args)]); return methods.petState ? methods.petState() : current; },
    setPet(patch) { calls.push(['setPet', plain(patch)]); if (methods.setPet) return methods.setPet(patch); current = { ...current, ...patch }; return current; },
    onEvent(listener) { events.add(listener); return () => events.delete(listener); },
  };
  const ui = context.ForgePetOverlay.create({ document, bridge, notice: (...args) => notices.push(args), onConfigure: () => configured.push(true) });
  return { ui, document, view, motion, observers, frames, calls, notices, configured, events, gaze, node: id => document.elements.get(id),
    flushFrames() { const batch = [...frames.values()]; frames.clear(); for (const callback of batch) callback(); },
    emit(event) { for (const listener of events) listener(event); },
    pointer(name, x, y, extra = {}) { document.elements.get('pet-overlay-hit').emit(name, { button: 0, pointerId: 8, clientX: x, clientY: y, ...extra }); },
  };
}
const settled = () => new Promise(resolve => setImmediate(resolve));

test('pet uses local transparent video with no model or plugin execution and an accessible small overlay', async () => {
  const f = fixture(); await f.ui.ready;
  assert.deepEqual(f.calls, [['petState', []]]);
  const overlay = f.node('pet-overlay'), video = f.node('pet-overlay-video');
  assert.equal(overlay.hidden, false); assert.equal(overlay.style.width, '220px');
  assert.equal(overlay.style.left, '772px'); assert.equal(overlay.style.top, '572px');
  assert.equal(video.src, 'file:///D:/app/pet/idle.webm'); assert.equal(video.muted, true); assert.equal(video.playsInline, true);
  assert.equal(f.node('pet-overlay-hit').tag, 'button'); assert.match(f.node('pet-overlay-hit').attributes['aria-label'], /左键聊天，拖动移动，右键打开菜单/u);
  assert.equal(video.loop, true); assert.equal(video.playCount, 1);
  f.node('pet-overlay-video').emit('error');
  assert.equal(video.hidden, true); assert.equal(f.node('pet-overlay-fallback').hidden, false);
  f.node('pet-overlay-fallback').emit('click'); assert.equal(f.configured.length, 1);
});

test('only a compact character button accepts pet interactions while the complete animation stays visible', async () => {
  const f = fixture({ gazeEnabled: true }); await f.ui.ready;
  const overlay = f.node('pet-overlay'), video = f.node('pet-overlay-video'), hit = f.node('pet-overlay-hit');
  const size = parseFloat(overlay.style.width), width = parseFloat(hit.style.width), height = parseFloat(hit.style.height);
  assert.ok(width < size * .5 && height < size * .6, 'Transparent source padding must not remain interactive');
  assert.ok(parseFloat(hit.style.left) > size * .2 && parseFloat(hit.style.top) > size * .2);
  assert.equal(video.tabIndex, -1); assert.equal(video.attributes['aria-hidden'], 'true');
  assert.equal(hit.tag, 'button'); assert.equal(hit.attributes['aria-haspopup'], 'menu');
  assert.equal(overlay.style.width, '220px'); assert.equal(overlay.style.height, '220px');
  assert.equal(f.gaze.options.bounds().width, 220, 'Gaze and animation rendering retain the original full picture bounds');
  let opens = 0; f.view.addEventListener('synora:pet-chat-open', () => ++opens);
  video.emit('pointerdown', { button: 0, pointerId: 9 }); video.emit('pointerup', { button: 0, pointerId: 9 });
  video.emit('contextmenu', { clientX: 800, clientY: 600 });
  assert.equal(opens, 0); assert.equal(f.node('pet-overlay-menu').hidden, true);
  hit.emit('keydown', { key: 'Enter' }); assert.equal(opens, 1);
  f.ui.destroy();
});

test('imported pets use their own contained video bounds instead of the bundled character measurements', async () => {
  const imported = state(); imported.packId = imported.packs[0].id = 'local-imported';
  const f = fixture({ initial: imported }); await f.ui.ready;
  const video = f.node('pet-overlay-video'), hit = f.node('pet-overlay-hit');
  video.videoWidth = 400; video.videoHeight = 100; video.emit('loadedmetadata');
  assert.ok(Math.abs(parseFloat(hit.style.width) - 220) < .001); assert.ok(Math.abs(parseFloat(hit.style.height) - 55) < .001);
  assert.ok(Math.abs(parseFloat(hit.style.left)) < .001); assert.ok(Math.abs(parseFloat(hit.style.top) - 82.5) < .001);
  assert.equal(f.node('pet-overlay').style.width, '220px');
  f.ui.destroy();
});

test('late initial reads cannot replace a newer saved pet event', async () => {
  const read = deferred(), f = fixture({ methods: { petState: () => read.promise } });
  f.emit({ type: 'pet-state', pet: state({ enabled: false, size: 400 }) });
  read.resolve(state()); await f.ui.ready;
  assert.equal(f.node('pet-overlay').hidden, true); assert.equal(f.ui.snapshot().size, 400);
});

test('drag captures the pointer, plays the drag clip and clamps persisted coordinates to the window', async () => {
  const f = fixture(); await f.ui.ready; const video = f.node('pet-overlay-video');
  f.pointer('pointerdown', 900, 700); assert.equal(f.node('pet-overlay-hit').pointer, 8);
  f.pointer('pointermove', 899, 699); assert.equal(f.node('pet-overlay').dataset.animation, 'idle');
  f.pointer('pointermove', -500, -500); assert.equal(f.node('pet-overlay').dataset.animation, 'drag');
  assert.equal(f.node('pet-overlay').style.left, '8px'); assert.equal(f.node('pet-overlay').style.top, '46px');
  f.pointer('pointerup', -500, -500); await settled();
  assert.deepEqual(f.calls.at(-1), ['setPet', { x: 0, y: 0 }]); assert.equal(f.node('pet-overlay-hit').pointer, null);
  assert.equal(f.node('pet-overlay').dataset.animation, 'idle');
  f.view.innerWidth = 150; f.view.innerHeight = 160; f.view.emit('resize');
  const bounds = f.node('pet-overlay').getBoundingClientRect();
  assert.ok(bounds.left + bounds.width <= 150); assert.ok(bounds.top + bounds.height <= 160);
});

test('pet bounds reserve the entire visible composer and approval controls through layout changes without altering saved positions', async () => {
  const f = fixture({ composerTop: 600 }); await f.ui.ready;
  const overlay = f.node('pet-overlay');
  assert.equal(overlay.getBoundingClientRect().bottom, 592);
  assert.equal(overlay.getBoundingClientRect().height, 220);
  const observer = f.observers[0]; assert.ok(observer.targets.has(f.node('task-form')));
  assert.ok(observer.targets.has(f.node('composer-approval')));
  f.node('task-form').hidden = true; f.node('composer-approval').hidden = false;
  f.node('composer-approval').bounds = { ...f.node('composer-approval').bounds, top: 220, height: 560 };
  observer.callback(); f.flushFrames();
  assert.equal(overlay.getBoundingClientRect().bottom, 212);
  assert.equal(overlay.getBoundingClientRect().height, 166, 'The displayed pet shrinks when an expanded approval needs more space');
  assert.equal(f.ui.snapshot().size, 220); assert.equal(f.ui.snapshot().x, 1); assert.equal(f.ui.snapshot().y, 1);
  assert.equal(f.calls.length, 1, 'Layout changes do not rewrite saved size or normalized position');
  f.node('composer-approval').bounds = { ...f.node('composer-approval').bounds, top: 70, height: 710 };
  observer.callback(); f.flushFrames(); assert.equal(overlay.hidden, true, 'When no useful space remains the pet temporarily yields to the controls');
  f.node('composer-approval').hidden = true; f.node('task-form').hidden = false;
  observer.callback(); f.flushFrames(); assert.equal(overlay.hidden, false); assert.equal(overlay.getBoundingClientRect().bottom, 592);
  f.node('composer-area').hidden = true; f.node('task-form').hidden = true;
  observer.callback(); f.flushFrames(); assert.equal(overlay.getBoundingClientRect().bottom, 792, 'Hidden composer regions do not reserve stale bounds');
  f.ui.destroy(); assert.equal(observer.disconnected, true);
});

test('ResizeObserver notifications coalesce into one later frame and teardown cancels pending layout work', async () => {
  const f = fixture({ composerTop: 600 }); await f.ui.ready;
  const overlay = f.node('pet-overlay'), observer = f.observers[0];
  f.node('composer-area').bounds = { ...f.node('composer-area').bounds, top: 400, height: 380 };
  observer.callback(); observer.callback(); observer.callback();
  assert.equal(f.frames.size, 1, 'Repeated observer deliveries schedule only one layout');
  assert.equal(overlay.getBoundingClientRect().bottom, 592, 'Observer delivery never writes styles synchronously');
  f.flushFrames(); assert.equal(overlay.getBoundingClientRect().bottom, 392); assert.equal(f.frames.size, 0);
  observer.callback(); assert.equal(f.frames.size, 1);
  f.ui.destroy(); assert.equal(f.frames.size, 0); assert.equal(observer.disconnected, true);
  observer.callback(); assert.equal(f.frames.size, 0, 'A late observer callback cannot schedule work after disposal');
});

test('left click and Enter or Space open chat without playing an action, while the context menu still pats the pet', async () => {
  const f = fixture(); await f.ui.ready;
  const chats = [], actions = [], video = f.node('pet-overlay-video'), menu = f.node('pet-overlay-menu');
  f.view.addEventListener('synora:pet-chat-open', event => { assert.equal(menu.hidden, true); chats.push(event); });
  f.view.addEventListener('synora:pet-action', event => actions.push(event.detail));
  f.node('pet-overlay-hit').emit('contextmenu', { clientX: 800, clientY: 600 }); assert.equal(menu.hidden, false);
  f.pointer('pointerdown', 800, 600); f.pointer('pointerup', 800, 600);
  assert.equal(chats.length, 1); assert.equal(f.node('pet-overlay').dataset.animation, 'idle'); assert.equal(video.loop, true);
  f.node('pet-overlay-hit').emit('contextmenu', { clientX: 800, clientY: 600 });
  f.node('pet-overlay-hit').emit('keydown', { key: 'Enter' }); f.node('pet-overlay-hit').emit('keydown', { key: ' ' });
  assert.equal(chats.length, 3); assert.equal(actions.length, 0);
  f.node('pet-overlay-hit').emit('keydown', { key: 'Enter', repeat: true }); f.node('pet-overlay-hit').emit('keydown', { key: 'Enter', isComposing: true });
  assert.equal(chats.length, 3, 'Held keys and IME confirmation do not reopen chat');
  f.node('pet-overlay-hit').emit('contextmenu', { clientX: 800, clientY: 600 }); f.node('pet-overlay-pat').emit('click');
  assert.equal(f.node('pet-overlay').dataset.animation, 'clicks'); assert.equal(video.loop, false);
  assert.equal(chats.length, 3); assert.deepEqual(actions.map(value => value.kind), ['clicks']);
  video.emit('ended'); assert.equal(f.node('pet-overlay').dataset.animation, 'idle');
  assert.equal(f.calls.length, 1, 'Overlay interaction only dispatches chat intent; it does not request a model or change stored state');
});

test('dragging, pointer cancellation, another pointer and secondary clicks never open chat', async () => {
  const f = fixture(); await f.ui.ready; const chats = [];
  f.view.addEventListener('synora:pet-chat-open', event => chats.push(event));
  f.pointer('pointerdown', 800, 600); f.pointer('pointermove', 700, 500); f.pointer('pointerup', 700, 500);
  f.pointer('pointerdown', 800, 600); f.pointer('pointercancel', 800, 600);
  f.pointer('pointerdown', 800, 600); f.pointer('pointermove', 700, 500); f.pointer('pointercancel', 700, 500);
  f.pointer('pointerdown', 800, 600); f.pointer('pointerup', 800, 600, { pointerId: 99 }); f.pointer('pointercancel', 800, 600);
  f.pointer('pointerdown', 800, 600, { button: 2 }); f.pointer('pointerup', 800, 600, { button: 2 });
  assert.equal(chats.length, 0);
  f.ui.destroy(); f.node('pet-overlay-hit').emit('keydown', { key: 'Enter' });
  assert.equal(chats.length, 0, 'A detached or hidden pet cannot reopen chat');
});

test('task states track parallel tools, approvals, results and completion only in the current workspace', async () => {
  const f = fixture(); await f.ui.ready;
  const kind = () => f.node('pet-overlay').dataset.animation;
  f.ui.updateState({ workspaceId: 'one', activeTask: { running: false } });
  f.emit({ type: 'run-start', workspaceId: 'other' }); assert.equal(kind(), 'idle');
  f.emit({ type: 'run-start', workspaceId: 'one' }); assert.equal(kind(), 'thinking');
  f.emit({ type: 'tool-start', toolCallId: 'a' }); f.emit({ type: 'tool-start', toolCallId: 'b' }); assert.equal(kind(), 'working');
  f.emit({ type: 'tool-result', toolCallId: 'a' }); assert.equal(kind(), 'working');
  f.emit({ type: 'approval-request', id: 'approval-a' }); f.emit({ type: 'approval-request', id: 'approval-b' }); assert.equal(kind(), 'waiting');
  f.emit({ type: 'approval-resolved', id: 'approval-a' }); assert.equal(kind(), 'waiting');
  f.emit({ type: 'approval-resolved', id: 'approval-b' }); assert.equal(kind(), 'working');
  f.emit({ type: 'tool-result', toolCallId: 'b' }); assert.equal(kind(), 'thinking');
  f.emit({ type: 'text-delta', text: 'hello' }); assert.equal(kind(), 'result');
  f.emit({ type: 'run-end', status: 'completed' }); assert.equal(kind(), 'success');
  f.node('pet-overlay-video').emit('ended'); assert.equal(kind(), 'idle');
  f.emit({ type: 'run-start' }); f.emit({ type: 'run-end', status: 'failed' }); assert.equal(kind(), 'error');
  f.emit({ type: 'pet-state', pet: state({ workStatus: false }) });
  f.emit({ type: 'run-start' }); assert.equal(kind(), 'idle');
});

test('reduced motion and a hidden window pause video without losing the pet position or making requests', async () => {
  const f = fixture({ reduced: true }); await f.ui.ready;
  const video = f.node('pet-overlay-video'); assert.equal(video.playCount, 0); assert.ok(video.pauseCount > 0);
  f.motion.matches = false; f.motion.emit('change'); assert.equal(video.playCount, 1);
  f.document.hidden = true; f.document.emit('visibilitychange'); const paused = video.pauseCount;
  assert.ok(paused > 1);
  f.document.hidden = false; f.document.emit('visibilitychange'); assert.equal(video.playCount, 2);
  assert.equal(f.node('pet-overlay').style.left, '772px'); assert.equal(f.calls.length, 1);
});

test('the pet menu stays within the window and explicit actions reset, configure or hide the pet', async () => {
  const f = fixture(); await f.ui.ready;
  f.node('pet-overlay-hit').emit('contextmenu', { clientX: 999, clientY: 799 });
  const menu = f.node('pet-overlay-menu'); assert.equal(menu.hidden, false); assert.equal(menu.style.left, '832px'); assert.equal(menu.style.top, '542px');
  f.node('pet-overlay-settings').emit('click'); assert.equal(f.configured.length, 1); assert.equal(menu.hidden, true);
  f.node('pet-overlay-hit').emit('keydown', { key: 'ContextMenu' });
  f.node('pet-overlay-reset').emit('click'); await settled(); assert.deepEqual(f.calls.at(-1), ['setPet', { x: 1, y: 1 }]);
  f.node('pet-overlay-hit').emit('contextmenu', { clientX: 900, clientY: 600 });
  f.document.emit('keydown', { key: 'Escape' }); assert.equal(menu.hidden, true);
  f.node('pet-overlay-hit').emit('contextmenu', { clientX: 900, clientY: 600 });
  f.node('pet-overlay-hide').emit('click'); await settled();
  assert.deepEqual(f.calls.at(-1), ['setPet', { enabled: false }]); assert.equal(f.node('pet-overlay').hidden, true);
});

test('ordered saves cannot be rewound by an earlier IPC result and keyboard movement persists clamped coordinates', async () => {
  const first = deferred(), second = deferred(); let count = 0;
  const f = fixture({ methods: { setPet: () => ++count === 1 ? first.promise : second.promise } }); await f.ui.ready;
  const a = f.ui.set({ x: .2 }), b = f.ui.set({ x: .8 });
  second.resolve(state({ x: .8 })); await b; first.resolve(state({ x: .2 })); await a;
  assert.equal(f.ui.snapshot().x, .8);
  const keyboard = fixture(); await keyboard.ui.ready;
  keyboard.node('pet-overlay-hit').emit('keydown', { key: 'ArrowLeft', shiftKey: true }); await settled();
  assert.deepEqual(keyboard.calls.at(-1), ['setPet', { x: .9, y: 1 }]);
});

test('untrusted URL schemes are not loaded and teardown releases media, events and in-flight reads', async () => {
  const untrusted = state(); untrusted.packs[0].animations.idle[0].url = 'https://untrusted.example/pet.webm';
  const f = fixture({ initial: untrusted }); await f.ui.ready;
  assert.equal(f.node('pet-overlay-video').src, undefined);
  const pending = deferred(), late = fixture({ methods: { petState: () => pending.promise } });
  late.ui.destroy(); pending.resolve(state()); await late.ui.ready;
  assert.equal(late.events.size, 0); assert.equal(late.node('pet-overlay').removed, true); assert.equal(late.node('pet-overlay-menu').removed, true);
  assert.equal(late.node('pet-overlay-video').src, '');
  assert.equal(late.document.listeners.get('keydown').size, 0); assert.equal(late.view.listeners.get('resize').size, 0);
});

test('idle eye following receives in-window and desktop cursor positions and pauses for every action or task', async () => {
  const f = fixture({ gazeEnabled: true }); await f.ui.ready;
  assert.equal(f.ui.snapshot().followCursor, true); assert.equal(f.gaze.active, true);
  assert.equal(f.gaze.options.canvas, f.node('pet-overlay-gaze'));
  f.document.emit('pointermove', { clientX: 10, clientY: 20, pointerType: 'mouse' });
  assert.deepEqual(f.gaze.points.at(-1), { x: 10, y: 20 });
  f.document.emit('pointermove', { clientX: 30, clientY: 40, pointerType: 'touch' });
  assert.equal(f.gaze.points.length, 1);
  f.emit({ type: 'pet-pointer', x: -300, y: 1200 });
  assert.equal(f.gaze.points.at(-1).x, -300); assert.equal(f.gaze.points.at(-1).y, 1200);
  f.pointer('pointerdown', 800, 600); assert.equal(f.gaze.active, false);
  f.pointer('pointercancel', 800, 600); assert.equal(f.gaze.active, true);
  f.pointer('pointerdown', 800, 600); f.pointer('pointerup', 800, 600); assert.equal(f.gaze.active, true, 'Opening chat does not play a transient animation');
  f.node('pet-overlay-hit').emit('contextmenu', { clientX: 800, clientY: 600 });
  f.node('pet-overlay-pat').emit('click'); assert.equal(f.gaze.active, false);
  f.node('pet-overlay-video').emit('ended'); assert.equal(f.gaze.active, true);
  f.emit({ type: 'run-start' }); assert.equal(f.gaze.active, false);
  f.emit({ type: 'pet-state', pet: state({ workStatus: false }) }); assert.equal(f.gaze.active, false, 'Disabling task animations does not pretend a running task is idle');
  f.emit({ type: 'run-end', status: 'stopped' }); assert.equal(f.gaze.active, true);
  f.emit({ type: 'tool-start', toolCallId: 'a' }); assert.equal(f.gaze.active, false);
  f.emit({ type: 'tool-result', toolCallId: 'a' }); assert.equal(f.gaze.active, true);
  f.emit({ type: 'approval-request', id: 'a' }); assert.equal(f.gaze.active, false);
  f.emit({ type: 'approval-resolved', id: 'a' }); assert.equal(f.gaze.active, true);
  f.view.emit('blur'); assert.equal(f.gaze.active, true, 'A visible idle pet keeps following desktop cursor positions while unfocused');
  f.document.emit('mouseleave'); f.emit({ type: 'pet-pointer', x: -500, y: -100, inside: false });
  assert.deepEqual(f.gaze.points.at(-1), { type: 'pet-pointer', x: -500, y: -100, inside: false });
  assert.equal(f.gaze.active, true); f.view.emit('focus'); assert.equal(f.gaze.active, true);
  f.document.hidden = true; f.document.emit('visibilitychange'); assert.equal(f.gaze.active, false);
  f.document.hidden = false; f.document.emit('visibilitychange'); assert.equal(f.gaze.active, true);
  f.motion.matches = true; f.motion.emit('change'); assert.equal(f.gaze.active, false);
  f.motion.matches = false; f.motion.emit('change'); assert.equal(f.gaze.active, true);
  f.emit({ type: 'pet-state', pet: state({ followCursor: false }) }); assert.equal(f.gaze.active, false);
  f.emit({ type: 'pet-state', pet: state() }); assert.equal(f.gaze.active, true);
  f.node('pet-overlay-video').emit('error'); assert.equal(f.gaze.active, false);
  f.ui.destroy(); assert.equal(f.gaze.destroyed, true);
  assert.equal(f.document.listeners.get('pointermove').size, 0);
});

test('imported pets never use the bundled character eye geometry and a hidden pet does no gaze work', async () => {
  const imported = state(); imported.packId = imported.packs[0].id = 'local-123456789012345678901234';
  const f = fixture({ initial: imported, gazeEnabled: true }); await f.ui.ready; assert.equal(f.gaze.active, false);
  assert.equal(f.node('pet-overlay').dataset.packId, imported.packId);
  f.emit({ type: 'pet-state', pet: state() }); assert.equal(f.gaze.active, true);
  assert.equal(f.node('pet-overlay').dataset.packId, 'dsh-pet');
  f.emit({ type: 'pet-state', pet: state({ enabled: false }) }); assert.equal(f.gaze.active, false);
});

test('following freezes only the bundled idle video, pointer events never play a turn, and manual turn still works', async () => {
  const f = fixture({ gazeEnabled: true }); await f.ui.ready;
  const video = f.node('pet-overlay-video'); assert.equal(video.playCount, 0); assert.ok(video.pauseCount > 0);
  for (let i = 0; i < 20; i++) f.document.emit('pointermove', { pointerType: 'mouse', clientX: i * 50, clientY: 20 });
  assert.equal(f.node('pet-overlay').dataset.animation, 'idle'); assert.equal(video.playCount, 0);
  f.node('pet-overlay-hit').emit('contextmenu', { clientX: 900, clientY: 500 }); f.node('pet-overlay-turn').emit('click');
  assert.equal(f.node('pet-overlay').dataset.animation, 'turn'); assert.ok(video.playCount > 0); assert.equal(f.gaze.active, false);
  video.emit('ended'); assert.equal(f.node('pet-overlay').dataset.animation, 'idle'); assert.equal(f.gaze.active, true);
  const plays = video.playCount; f.emit({ type: 'pet-state', pet: state({ followCursor: false }) }); assert.ok(video.playCount > plays);
  f.ui.destroy();
});

test('local action notifications happen once per actual clip start, never for pointer tracking or video loops', async () => {
  const f = fixture({ gazeEnabled: true }), actions = [];
  f.view.addEventListener('synora:pet-action', event => actions.push(plain(event.detail)));
  await f.ui.ready; assert.deepEqual(actions, [{ kind: 'idle', sequence: 1 }]);
  f.emit({ type: 'state', state: { activeTask: { running: false } } });
  f.document.emit('pointermove', { pointerType: 'mouse', clientX: 10, clientY: 20 });
  f.node('pet-overlay-video').emit('ended'); assert.equal(actions.length, 1);
  f.emit({ type: 'run-start' }); assert.equal(actions.at(-1).kind, 'thinking');
  f.emit({ type: 'tool-start', toolCallId: 'one' }); assert.equal(actions.at(-1).kind, 'working');
  const before = actions.length; f.emit({ type: 'tool-start', toolCallId: 'two' }); assert.equal(actions.length, before);
  f.emit({ type: 'run-end', status: 'completed' }); assert.equal(actions.at(-1).kind, 'success');
  f.node('pet-overlay-video').emit('ended'); assert.equal(actions.at(-1).kind, 'idle');
  assert.deepEqual(actions.map(value => value.sequence), actions.map((_, index) => index + 1));
  f.ui.destroy();
});

test('opening, resizing and closing chat never moves or resizes the pet', async () => {
  const f = fixture({ composerTop: 600 }); await f.ui.ready;
  const original = { ...f.node('pet-overlay').style }, hit = { ...f.node('pet-overlay-hit').style };
  assert.equal(f.node('pet-overlay').getBoundingClientRect().bottom, 592);
  f.view.emit('synora:pet-chat-layout', { detail: { open: true, height: 150 } }); f.flushFrames();
  assert.equal(f.node('pet-overlay').getBoundingClientRect().bottom, 592);
  assert.equal(f.ui.snapshot().y, 1); assert.equal(f.calls.length, 1);
  f.view.emit('synora:pet-chat-layout', { detail: { open: true, height: 150 } }); assert.equal(f.frames.size, 0);
  f.view.emit('synora:pet-chat-layout', { detail: { open: true, height: 300 } }); f.flushFrames();
  assert.deepEqual(f.node('pet-overlay').style, original); assert.deepEqual(f.node('pet-overlay-hit').style, hit);
  f.view.emit('synora:pet-chat-layout', { detail: { open: false, height: 0 } }); f.flushFrames();
  assert.equal(f.node('pet-overlay').getBoundingClientRect().bottom, 592);
  assert.deepEqual(f.node('pet-overlay').style, original); assert.deepEqual(f.node('pet-overlay-hit').style, hit);
  f.ui.destroy(); assert.equal(f.view.listeners.get('synora:pet-chat-layout')?.size || 0, 0);
});
