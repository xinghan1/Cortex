import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../src/renderer/pet-gaze.js', import.meta.url), 'utf8');
const context = vm.createContext({ Uint8Array, Uint8ClampedArray }); vm.runInContext(source, context);
const { eyesIn, warpEyes, create } = context.ForgePetGaze;
function face({ blink = false, shift = 0 } = {}) {
  const width = 116, height = 28, data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    data.set([235 - y, 205 - y, 190 - y, x < 3 ? 0 : 255], offset);
    if (!blink && [29 + shift, 78 + shift].some(center => ((x - center) / 6) ** 2 + ((y - 12) / 6) ** 2 < 1))
      data.set([45, 110 + y, 182 + y, 255], offset);
    if (!blink && [29 + shift, 78 + shift].some(center => Math.abs(x - center) <= 1 && y >= 7 && y <= 11))
      data.set([10, 25, 65, 255], offset);
  }
  return { width, height, data };
}
const clone = frame => ({ width: frame.width, height: frame.height, data: new Uint8ClampedArray(frame.data) });

test('the bundled idle detector tracks both irises across head movement and leaves blinks alone', () => {
  const straight = eyesIn(face()), turned = eyesIn(face({ shift: 10 }));
  assert.equal(straight.length, 2); assert.equal(turned.length, 2);
  assert.ok(Math.abs(turned[0].x - straight[0].x - 10) < .1);
  assert.ok(straight.every(eye => eye.rx >= 6 && eye.rx <= 10.5 && eye.ry === 9));
  assert.equal(eyesIn(face({ blink: true })).length, 0);
  const invisible = face(); for (let index = 3; index < invisible.data.length; index += 4) invisible.data[index] = 0;
  assert.equal(eyesIn(invisible).length, 0, 'Transparent blue pixels are never mistaken for eyes');
  const single = face(); for (let y = 0; y < 28; y++) for (let x = 58; x < 116; x++) single.data.set([235, 205, 190, 255], (y * 116 + x) * 4);
  assert.equal(eyesIn(single).length, 0, 'A single blue component does not manufacture another eye');
});

test('local eye warp preserves every pixel outside its two feathered ellipses and all unrelated transparency', () => {
  const original = face(), eyes = eyesIn(original), right = warpEyes(clone(original), eyes, 3.2, 1.8), left = warpEyes(clone(original), eyes, -3.2, -1.8);
  let changed = 0;
  for (let y = 0; y < original.height; y++) for (let x = 0; x < original.width; x++) {
    const offset = (y * original.width + x) * 4;
    const inside = eyes.some(eye => ((x - eye.x) / eye.rx) ** 2 + ((y - eye.y) / eye.ry) ** 2 < 1);
    if (!inside) assert.deepEqual(right.data.subarray(offset, offset + 4), original.data.subarray(offset, offset + 4));
    if (right.data[offset] !== original.data[offset]) ++changed;
    assert.equal(right.data[offset + 3], original.data[offset + 3], 'The opaque eye and original background alpha are retained');
  }
  assert.ok(changed > 50, 'The original eye pixels actually shift');
  assert.notDeepEqual(right.data, left.data, 'Opposite cursor positions produce opposite local eye images');
  assert.deepEqual(warpEyes(clone(original), [], 3, 2).data, original.data);
  assert.deepEqual(warpEyes(clone(original), eyes, 0, 0).data, original.data);
});

function fixture({ readFails = false } = {}) {
  const frames = new Map(), visible = [], draws = []; let next = 0, now = 0;
  const view = {
    requestAnimationFrame(callback) { const id = ++next; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  const canvas = { hidden: true, dataset: {}, setAttribute() {},
    getContext: () => ({ clearRect() {}, drawImage: (...args) => draws.push(args),
      getImageData() { if (readFails) throw new Error('unavailable readback'); return face(); }, putImageData(frame, x, y) { canvas.lastFrame = { frame, x, y }; } }),
  };
  const video = { readyState: 2, videoWidth: 640, videoHeight: 360 };
  const ui = create({ document: { defaultView: view }, video, canvas,
    bounds: () => ({ left: 100, top: 200, width: 220, height: 220 }), onVisible: value => visible.push(value) });
  return { ui, canvas, video, frames, draws, visible,
    tick(count = 1) { for (let i = 0; i < count; i++) { now += 40; const batch = [...frames.values()]; frames.clear(); for (const callback of batch) callback(now); } },
  };
}

test('cursor tracking uses bounded smooth eye offsets while the native video remains the frame source', () => {
  const f = fixture(); f.ui.point({ x: 100000, y: -100000 }); f.ui.setActive(true);
  f.tick(); assert.equal(f.canvas.hidden, false); assert.equal(f.canvas.dataset.gaze, 'tracking');
  const first = Number(f.canvas.dataset.gazeX); assert.ok(first > 0 && first < 1);
  f.tick(35); assert.ok(Number(f.canvas.dataset.gazeX) > 3 && Number(f.canvas.dataset.gazeX) <= 3.2);
  assert.ok(Number(f.canvas.dataset.gazeY) >= -1.8 && Number(f.canvas.dataset.gazeY) < -1.7);
  assert.equal(f.canvas.width, 640); assert.equal(f.canvas.height, 360);
  assert.equal(f.canvas.lastFrame.x, 256); assert.equal(f.canvas.lastFrame.y, 180);
  assert.equal(f.draws[0][0], f.video, 'The canvas draws the same authentic decoded video');
  f.ui.point({ x: -100000, y: 100000 }); f.tick(40);
  assert.ok(Number(f.canvas.dataset.gazeX) < -3); assert.ok(Number(f.canvas.dataset.gazeY) > 1.7);
  f.ui.point(null); f.tick(40); assert.ok(Math.abs(Number(f.canvas.dataset.gazeX)) < .01);
  f.ui.destroy(); assert.equal(f.frames.size, 0); assert.equal(f.canvas.hidden, true);
});

test('idle tracking cancels scheduled work and recenters across actions, then can restart without a stale frame', () => {
  const f = fixture(); f.ui.point({ x: 100000, y: 100000 }); f.ui.setActive(true); f.tick(10);
  f.ui.setActive(false); assert.equal(f.frames.size, 0); assert.equal(f.canvas.hidden, true); assert.equal(f.canvas.dataset.gaze, 'off');
  f.ui.setActive(true); f.tick(); assert.ok(Number(f.canvas.dataset.gazeX) < 1, 'A resumed idle starts centered rather than jumping to the old offset');
  f.ui.destroy(); f.ui.setActive(true); f.tick(); assert.equal(f.frames.size, 0); assert.equal(f.canvas.hidden, true);
});

test('unsupported frames or canvas failures preserve the original video and clean up without a retry loop', () => {
  const unsupported = fixture(); unsupported.video.videoWidth = 100; unsupported.ui.setActive(true); unsupported.tick();
  assert.equal(unsupported.draws.length, 0); assert.equal(unsupported.canvas.hidden, true); unsupported.ui.destroy();
  const broken = fixture({ readFails: true }); broken.ui.setActive(true); broken.tick();
  assert.equal(broken.canvas.hidden, true); assert.equal(broken.frames.size, 0);
  broken.ui.setActive(true); broken.tick(); assert.equal(broken.frames.size, 0);
  const unavailable = { hidden: false, dataset: {}, setAttribute() {}, getContext() { throw new Error('no canvas'); } };
  const ui = create({ document: { defaultView: {} }, canvas: unavailable }); ui.setActive(true); ui.destroy();
  assert.equal(unavailable.hidden, true);
});
