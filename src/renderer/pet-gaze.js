'use strict';
(function (root) {
  // These measurements and the blue-iris detector belong to the bundled DSH
  // idle clip, not arbitrary imported pets. Cursor following uses its original
  // front-facing frame; the clip itself contains sideways poses later on.
  const WIDTH = 640, HEIGHT = 360;
  const FRONT_TIME = .5;
  const FACE = Object.freeze({ x: 256, y: 166, width: 116, height: 44 });
  const HEAD = Object.freeze({ x: 204, y: 50, width: 220, height: 190 });
  const clamp = (number, low, high) => Math.max(low, Math.min(high, number));
  function eyesIn(frame) {
    const { data, width, height } = frame, mask = new Uint8Array(width * height), components = [];
    for (let index = 0; index < mask.length; index++) {
      const offset = index * 4, red = data[offset], green = data[offset + 1], blue = data[offset + 2];
      if (data[offset + 3] > 230 && green > 45 && green < 190 && blue > 95
        && green - red > 32 && blue - red > 58 && green / blue > .48) mask[index] = 1;
    }
    for (let index = 0; index < mask.length; index++) {
      if (!mask[index]) continue;
      mask[index] = 0;
      const pending = [index]; let count = 0, sumX = 0, sumY = 0, minX = width, maxX = 0, minY = height, maxY = 0;
      for (let cursor = 0; cursor < pending.length; cursor++) {
        const pixel = pending[cursor], x = pixel % width, y = Math.floor(pixel / width);
        ++count; sumX += x; sumY += y; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        const neighbors = [];
        if (x) neighbors.push(pixel - 1); if (x + 1 < width) neighbors.push(pixel + 1);
        if (y) neighbors.push(pixel - width); if (y + 1 < height) neighbors.push(pixel + width);
        for (const neighbor of neighbors) if (mask[neighbor]) { mask[neighbor] = 0; pending.push(neighbor); }
      }
      const spanX = maxX - minX + 1, spanY = maxY - minY + 1;
      if (count >= 7 && count <= 170 && spanX >= 2 && spanX <= 20 && spanY >= 3 && spanY <= 15)
        components.push({ x: sumX / count, y: sumY / count, count, spanX });
    }
    let pair = null, score = -1;
    for (const left of components) for (const right of components) {
      const distance = right.x - left.x;
      if (distance < 32 || distance > 57 || Math.abs(right.y - left.y) > 5) continue;
      const candidateScore = left.count + right.count;
      if (candidateScore > score) { score = candidateScore; pair = [left, right]; }
    }
    // A blink, occlusion or unfamiliar frame keeps the original eyes intact.
    return pair?.map(eye => ({ x: eye.x, y: eye.y - 3.5,
      rx: clamp(eye.spanX * .5 + 2, 6, 10.5), ry: 9 })) || [];
  }
  function warpEyes(frame, eyes, offsetX, offsetY) {
    if (!eyes.length || (!offsetX && !offsetY)) return frame;
    const source = new Uint8ClampedArray(frame.data), { data, width, height } = frame;
    for (const eye of eyes) {
      const minX = Math.max(0, Math.floor(eye.x - eye.rx)), maxX = Math.min(width - 1, Math.ceil(eye.x + eye.rx));
      const minY = Math.max(0, Math.floor(eye.y - eye.ry)), maxY = Math.min(height - 1, Math.ceil(eye.y + eye.ry));
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        const radius = ((x - eye.x) / eye.rx) ** 2 + ((y - eye.y) / eye.ry) ** 2;
        if (radius >= 1) continue;
        const weight = (1 - radius) ** 2;
        const sampleX = clamp(x - offsetX * weight, 0, width - 1), sampleY = clamp(y - offsetY * weight, 0, height - 1);
        const x0 = Math.floor(sampleX), y0 = Math.floor(sampleY), x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
        const fractionX = sampleX - x0, fractionY = sampleY - y0, destination = (y * width + x) * 4;
        for (let channel = 0; channel < 4; channel++) {
          const top = source[(y0 * width + x0) * 4 + channel] * (1 - fractionX) + source[(y0 * width + x1) * 4 + channel] * fractionX;
          const bottom = source[(y1 * width + x0) * 4 + channel] * (1 - fractionX) + source[(y1 * width + x1) * 4 + channel] * fractionX;
          data[destination + channel] = top * (1 - fractionY) + bottom * fractionY;
        }
      }
    }
    return frame;
  }
  function warpHead(frame, horizontal, vertical) {
    if (!horizontal && !vertical) return frame;
    const source = new Uint8ClampedArray(frame.data), { data, width, height } = frame;
    const centerX = 110, centerY = 95, radiusX = 104, radiusY = 92;
    const yaw = clamp(horizontal, -1, 1), pitch = clamp(vertical, -1, 1), roll = yaw * .045;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const dx = x - centerX, dy = y - centerY, radius = (dx / radiusX) ** 2 + (dy / radiusY) ** 2;
      if (radius >= 1) continue;
      const weight = (1 - radius) ** 2;
      const sx = clamp(x - (yaw * 10 - dy * roll) * weight, 0, width - 1);
      const sy = clamp(y - (pitch * 6 + dx * roll) * weight, 0, height - 1);
      const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
      const fx = sx - x0, fy = sy - y0, destination = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel++) {
        const top = source[(y0 * width + x0) * 4 + channel] * (1 - fx) + source[(y0 * width + x1) * 4 + channel] * fx;
        const bottom = source[(y1 * width + x0) * 4 + channel] * (1 - fx) + source[(y1 * width + x1) * 4 + channel] * fx;
        data[destination + channel] = top * (1 - fy) + bottom * fy;
      }
    }
    return frame;
  }
  function create({ document = root.document, video, canvas, bounds, onVisible = () => {} }) {
    const view = document.defaultView || root;
    let context;
    try { context = canvas.getContext?.('2d', { alpha: true, willReadFrequently: true }); } catch {}
    let active = false, disposed = false, failed = false, scheduled = null, visible = false;
    let cursor = null, x = 0, y = 0, lastFrame = 0;
    canvas.hidden = true; canvas.setAttribute('aria-hidden', 'true');
    const show = value => {
      canvas.hidden = !value;
      if (visible === value) return;
      visible = value; onVisible(value);
    };
    const cancel = () => { if (scheduled !== null) view.cancelAnimationFrame(scheduled); scheduled = null; };
    const draw = timestamp => {
      scheduled = null;
      if (!active || disposed || failed || !context) return;
      scheduled = view.requestAnimationFrame(draw);
      if (timestamp - lastFrame < 1000 / 30 || video.readyState < 2 || video.videoWidth !== WIDTH || video.videoHeight !== HEIGHT) return;
      video.pause();
      if (video.seeking) return;
      if (!Number.isFinite(video.currentTime) || Math.abs(video.currentTime - FRONT_TIME) > .01) {
        try { video.currentTime = FRONT_TIME; } catch { /* Metadata can still be loading. */ }
        return;
      }
      lastFrame = timestamp;
      const box = bounds(), pictureHeight = box.width * HEIGHT / WIDTH;
      const centerX = box.left + box.width * .485, centerY = box.top + (box.height - pictureHeight) / 2 + pictureHeight * .525;
      // The 640 px source is displayed in a 220 px pet box by default. A tiny
      // source warp used to become a barely visible fraction of a screen pixel,
      // especially when the pet sat against the right edge of the window.
      const distance = Math.max(60, box.width * .35);
      const targetX = cursor ? Math.tanh((cursor.x - centerX) / distance) * 5.2 : 0;
      const targetY = cursor ? Math.tanh((cursor.y - centerY) / distance) * 3.2 : 0;
      x += (targetX - x) * .24; y += (targetY - y) * .24;
      try {
        if (canvas.width !== WIDTH) canvas.width = WIDTH;
        if (canvas.height !== HEIGHT) canvas.height = HEIGHT;
        context.clearRect(0, 0, WIDTH, HEIGHT); context.drawImage(video, 0, 0, WIDTH, HEIGHT);
        const head = context.getImageData(HEAD.x, HEAD.y, HEAD.width, HEAD.height);
        warpHead(head, x / 5.2, y / 3.2); context.putImageData(head, HEAD.x, HEAD.y);
        const frame = context.getImageData(FACE.x, FACE.y, FACE.width, FACE.height), eyes = eyesIn(frame);
        if (eyes.length && (Math.abs(x) > .01 || Math.abs(y) > .01)) {
          warpEyes(frame, eyes, x, y); context.putImageData(frame, FACE.x, FACE.y);
        }
        canvas.dataset.gaze = eyes.length ? 'tracking' : 'blink';
        canvas.dataset.gazeX = x.toFixed(3); canvas.dataset.gazeY = y.toFixed(3);
        canvas.dataset.pose = 'front';
        show(true);
      } catch {
        // Decoder/readback failures degrade to the unmodified video, including
        // environments where a canvas cannot read the local transparent clip.
        failed = true; active = false; cancel(); show(false);
      }
    };
    return Object.freeze({
      setActive(value) {
        const next = value === true && !disposed && !failed && Boolean(context) && typeof view.requestAnimationFrame === 'function';
        if (active === next) return active;
        active = next;
        if (!active) { cancel(); x = y = lastFrame = 0; canvas.dataset.gaze = 'off'; show(false); }
        else { video.pause(); scheduled = view.requestAnimationFrame(draw); }
        return active;
      },
      point(point) { cursor = point && Number.isFinite(point.x) && Number.isFinite(point.y) ? { x: point.x, y: point.y } : null; },
      destroy() { disposed = true; active = false; cursor = null; cancel(); show(false); },
    });
  }
  root.ForgePetGaze = Object.freeze({ create, eyesIn, warpEyes, warpHead });
})(typeof globalThis === 'object' ? globalThis : this);
