'use strict';
const video = document.getElementById('pet'), gaze = document.getElementById('gaze'), fallback = document.getElementById('fallback');
let currentSrc = '';
window.petNative.onState(state => {
  if (typeof state.src === 'string' && state.src !== currentSrc) {
    currentSrc = state.src; video.src = currentSrc;
    video.addEventListener('loadedmetadata', () => { if (Number.isFinite(state.time)) video.currentTime = state.time; }, { once: true });
  }
  video.loop = state.loop === true;
  if (state.paused) video.pause(); else video.play().catch(() => {});
  fallback.hidden = !state.fallback;
  video.hidden = Boolean(state.fallback);
  gaze.hidden = !state.gazeData;
  if (state.gazeData && gaze.src !== state.gazeData) gaze.src = state.gazeData;
});
const names = { mousedown: 'mouseDown', mousemove: 'mouseMove', mouseup: 'mouseUp' };
document.addEventListener('pointerdown', event => { if (event.isTrusted) document.body.setPointerCapture(event.pointerId); });
for (const name of Object.keys(names)) document.addEventListener(name, event => {
  if (!event.isTrusted) return;
  window.petNative.input({ type: names[name], x: Math.round(event.clientX), y: Math.round(event.clientY),
    button: event.button === 2 ? 'right' : 'left', clickCount: event.detail || 1 });
}, true);
document.addEventListener('contextmenu', event => event.preventDefault());
