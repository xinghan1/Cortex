import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const context = vm.createContext({});
vm.runInContext(await fs.readFile(new URL('../src/renderer/image-view-card.js', import.meta.url), 'utf8'), context);
const api = context.ForgeImageViewCard;
const plain = value => JSON.parse(JSON.stringify(value));
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';
const attachment = { id: 'image-one', name: 'diagram.png', mediaType: 'image/png', dataUrl: `data:image/png;base64,${png}` };
const source = () => [{ id: 'user-one', role: 'user', content: 'Inspect.', attachments: [attachment] }];
const event = (images = [{ messageId: 'user-one', attachmentIndex: 0, attachmentId: 'image-one' }]) => ({
  type: 'images-viewed', version: 1, requestId: 'request-one', images });

class Element {
  constructor(tagName) { this.tagName = tagName; this.className = ''; this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = {}; this.hidden = false; this.disabled = false; this.content = ''; }
  set textContent(value) { this.content = String(value); this.children = []; }
  get textContent() { return this.content + this.children.map(child => child.textContent).join(''); }
  append(...children) { this.children.push(...children); }
  prepend(...children) { this.children.unshift(...children); }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  dispatch(type) { if (type === 'click' && this.disabled) return; for (const listener of this.listeners[type] || []) listener({ type, target: this }); }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(selector.startsWith('.') ? child.className.split(' ').includes(selector.slice(1)) : child.tagName === selector) ? [child] : [], ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
context.document = { createElement: tag => new Element(tag) };

test('references resolve only the confirmed original user attachment without copying private event fields', () => {
  const incoming = { ...event(), apiKey: 'private-key', providerState: { thinking: 'private-thought' } };
  const value = plain(api.resolve(incoming, source()));
  assert.equal(value.count, 1); assert.equal(value.availableCount, 1); assert.equal(value.missingCount, 0);
  assert.deepEqual(value.images[0], { messageId: 'user-one', attachmentIndex: 0, attachmentId: 'image-one', name: 'diagram.png',
    available: true, src: attachment.dataUrl, mediaType: 'image/png' });
  assert.equal(JSON.stringify(value).includes('private'), false);
  assert.deepEqual(plain(api.references({ ...incoming, type: 'user-message' })), [], 'upload alone is not a view receipt');
  assert.equal(api.create({ ...incoming, type: 'browser-capture' }, { messages: source() }), null);
});

test('missing, mismatched and ambiguous sources remain explicit missing previews without guessing a file or URL', () => {
  for (const messages of [[], [{ ...source()[0], role: 'assistant' }], [source()[0], source()[0]],
    [{ ...source()[0], attachments: [{ ...attachment, id: 'different' }] }]]) {
    const value = plain(api.resolve(event(), messages));
    assert.equal(value.count, 1); assert.equal(value.availableCount, 0); assert.equal(value.missingCount, 1);
    assert.equal(Object.hasOwn(value.images[0], 'src'), false);
    const card = api.create(event(), { messages });
    assert.match(card.textContent, /原图未保留/u); assert.equal(card.querySelectorAll('img').length, 0);
    assert.equal(card.querySelectorAll('button').length, 0);
  }
});

test('external, file, SVG and oversized image payloads never become image elements', () => {
  for (const dataUrl of ['https://example.invalid/image.png', 'file:///C:/private.png', 'javascript:alert(1)',
    'data:image/svg+xml;base64,PHN2Zy8+', 'data:image/png;base64,AAAAA', 'data:image/png;base64,' + 'A'.repeat(2800000)]) {
    const messages = [{ ...source()[0], attachments: [{ ...attachment, dataUrl }] }];
    const card = api.create(event(), { messages });
    assert.equal(card.querySelectorAll('img').length, 0); assert.equal(card.querySelectorAll('a').length, 0);
    assert.equal(plain(api.resolve(event(), messages)).images[0].available, false);
  }
  const wrongType = [{ ...source()[0], attachments: [{ ...attachment, mediaType: 'image/jpeg' }] }];
  assert.equal(api.resolve(event(), wrongType).availableCount, 0);
});

test('malformed references are bounded and repeated identities do not inflate the viewed count', () => {
  const refs = [...event().images, ...event().images, { messageId: 'user-one', attachmentIndex: -1 },
    { messageId: 'user-one', attachmentIndex: 4 }, { messageId: 'bad\u0000id', attachmentIndex: 0 },
    { messageId: '__proto__', attachmentIndex: 0 }, { messageId: 'constructor', attachmentIndex: 0 }];
  const value = api.resolve(event(refs), source());
  assert.equal(value.count, 3); assert.equal(value.availableCount, 1); assert.equal(value.missingCount, 2);
  assert.equal(api.create(event(Array(65).fill(event().images[0]))), null);
  assert.equal(api.create({ ...event(), version: 2 }), null);
  assert.equal(api.create(event([{ messageId: 'user-one', attachmentIndex: 0, attachmentId: '\n' }])) , null);
});

test('the card starts expanded, exposes a thumbnail and uses the supplied preview and expansion callbacks', () => {
  const previews = [], expanded = [];
  const card = api.create(event(), { messages: source(), onPreview: image => previews.push(image), onExpand: item => expanded.push(item) });
  assert.equal(card.tagName, 'details'); assert.equal(card.open, true); assert.equal(card.dataset.requestId, 'request-one');
  assert.match(card.querySelector('summary').textContent, /已查看 1 张图像/u);
  const thumbnail = card.querySelector('img');
  assert.equal(thumbnail.src, attachment.dataUrl); assert.equal(thumbnail.loading, 'lazy'); assert.equal(thumbnail.alt, 'diagram.png');
  card.querySelector('button').dispatch('click');
  assert.deepEqual(plain(previews), [{ src: attachment.dataUrl, name: 'diagram.png', mediaType: 'image/png' }]);
  card.open = false; card.dispatch('toggle'); assert.equal(expanded.length, 0);
  card.open = true; card.dispatch('toggle'); assert.equal(expanded[0], card);
  assert.equal(card.querySelectorAll('summary').length, 1); assert.equal(card.querySelectorAll('img').length, 1);
});

test('failed thumbnail decoding disables preview and reports a missing preview without inventing a replacement', () => {
  let previews = 0;
  const card = api.create(event(), { messages: source(), onPreview: () => { previews++; } });
  const thumbnail = card.querySelector('img'), button = card.querySelector('button');
  thumbnail.dispatch('error');
  assert.equal(thumbnail.hidden, true); assert.equal(button.disabled, true);
  assert.equal(card.querySelector('.image-view-unavailable').hidden, false);
  assert.match(card.textContent, /预览不可用/u);
  button.dispatch('click'); assert.equal(previews, 0);
});

test('attachment labels remain text, strip path/control characters, and use no HTML insertion', () => {
  const name = '<img src=x onerror=evil()>.png';
  const card = api.create(event(), { messages: [{ ...source()[0], attachments: [{ ...attachment, name: `C:\\folder\\\u202e${name}` }] }] });
  assert.equal(card.querySelector('.image-view-name').textContent, name);
  assert.equal(card.querySelectorAll('img').length, 1); assert.equal(card.querySelector('img').alt, name);
  assert.equal(card.textContent.includes('C:'), false); assert.equal(card.textContent.includes('\u202e'), false);
});
