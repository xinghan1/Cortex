import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const context = { window: {} };
runInNewContext(readFileSync(new URL('../src/renderer/image-preview-zoom.js', import.meta.url), 'utf8'), context);

class Target {
  listeners = {};
  addEventListener(name, listener, options) { this.listeners[name] = { listener, options }; }
  fire(name, properties = {}) {
    const event = { button: 0, pointerId: 1, clientX: 0, clientY: 0, deltaY: 0, prevented: false,
      preventDefault() { this.prevented = true; }, ...properties };
    this.listeners[name].listener(event);
    return event;
  }
}

function setup() {
  const dialog = { open: true };
  const viewport = new Target();
  const image = new Target();
  image.style = {};
  const classes = new Set();
  image.classList = { add: name => classes.add(name), remove: name => classes.delete(name) };
  image.getAttribute = () => 'test.png';
  image.getBoundingClientRect = () => ({ left: 100, top: 200, width: 200, height: 100 });
  let captured = null;
  image.setPointerCapture = id => { captured = id; };
  image.hasPointerCapture = id => captured === id;
  image.releasePointerCapture = () => { captured = null; };
  const control = context.window.CortexImagePreviewZoom.create(dialog, viewport, image);
  return { dialog, viewport, image, control, classes };
}

test('wheel zoom anchors to the pointer and limits its scale', () => {
  const { dialog, viewport, image } = setup();
  assert.equal(viewport.listeners.wheel.options.passive, false);
  const event = viewport.fire('wheel', { clientX: 150, clientY: 225, deltaY: -100 });
  assert.equal(event.prevented, true);
  const [, x, y, scale] = image.style.transform.match(/translate\(([-.\d]+)px, ([-.\d]+)px\) scale\(([-.\d]+)\)/).map(Number);
  assert.ok(Math.abs(scale - Math.exp(0.15)) < 1e-10);
  assert.ok(Math.abs(x - (150 - 200) * (1 - scale)) < 1e-10);
  assert.ok(Math.abs(y - (225 - 250) * (1 - scale)) < 1e-10);
  viewport.fire('wheel', { deltaY: -100000 });
  assert.match(image.style.transform, /scale\(8\)$/);
  viewport.fire('wheel', { deltaY: 100000 });
  assert.match(image.style.transform, /scale\(0\.25\)$/);
  dialog.open = false;
  assert.equal(viewport.fire('wheel', { deltaY: 1 }).prevented, false);
});

test('drag pans the image and reset clears state between previews', () => {
  const { viewport, image, control, classes } = setup();
  image.fire('pointerdown', { clientX: 10, clientY: 20 });
  assert.equal(classes.has('is-dragging'), true);
  image.fire('pointermove', { clientX: 35, clientY: 12 });
  assert.equal(image.style.transform, 'translate(25px, -8px) scale(1)');
  image.fire('pointerup');
  assert.equal(classes.has('is-dragging'), false);
  image.fire('pointerdown', { button: 2 });
  assert.equal(classes.has('is-dragging'), false);
  control.reset();
  assert.equal(image.style.transform, '');
  image.fire('pointerdown');
  image.fire('pointermove', { clientX: 4, clientY: 5 });
  viewport.fire('dblclick');
  assert.equal(image.style.transform, '');
  assert.equal(classes.has('is-dragging'), false);
});
