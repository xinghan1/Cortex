'use strict';

// Preview edits are a temporary copy. The original message attachment is never changed.
window.CortexImagePreviewEditor = (() => {
  let dialog, image, canvas, ctx, zoom, bridge, notify, openSide, generation = 0, ready = false, mode = '', drawing = false, pointerId = null, history = [], comment = '';
  const $id = id => document.getElementById(id);
  const status = text => { $id('image-preview-status').textContent = text; };
  function position() {
    if (canvas.hidden) return;
    const a = image.getBoundingClientRect(), b = image.parentElement.getBoundingClientRect();
    Object.assign(canvas.style, { left: `${a.left-b.left}px`, top: `${a.top-b.top}px`, width: `${a.width}px`, height: `${a.height}px` });
  }
  function snapshot() { history.push(canvas.toDataURL('image/png')); while (history.length > 1 && (history.length > 5 || history.reduce((n, item) => n + item.length, 0) > 24000000)) history.shift(); }
  function finishMode() {
    if (drawing) { drawing = false; ctx.restore(); }
    if (pointerId !== null && canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
    pointerId = null; mode = ''; canvas.hidden = true; image.style.visibility = '';
    if (ready) image.src = canvas.toDataURL('image/png');
    dialog.querySelectorAll('[data-image-tool]').forEach(button => button.classList.remove('active'));
    $id('image-preview-comment').hidden = true; $id('image-preview-resize').hidden = true;
  }
  async function prepare() {
    if (ready) return true;
    const token = generation;
    try { await image.decode(); } catch { status('图片尚未加载完成'); return false; }
    if (token !== generation || !dialog.open) return false;
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 16000000) { status('图片过大，无法编辑（最多 1600 万像素）'); return false; }
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0); ready = true; return true;
  }
  function activate(next) {
    zoom.reset(); mode = next; canvas.hidden = false; image.style.visibility = 'hidden'; position();
    dialog.querySelectorAll('[data-image-tool]').forEach(button => button.classList.toggle('active', button.dataset.imageTool === next));
    status(next === 'comment' ? '点击图片放置评论，评论会合并到导出图片' : next === 'erase' ? '拖动擦除图片像素' : '拖动绘制标注');
  }
  function point(event) { const r = canvas.getBoundingClientRect(); return { x: (event.clientX-r.left)*canvas.width/r.width, y: (event.clientY-r.top)*canvas.height/r.height }; }
  function bind(options) {
    ({ dialog, image, zoom, bridge, openSide } = options); notify = options.notice; canvas = $id('image-preview-canvas');
    const bar = dialog.querySelector('.image-preview-tools');
    dialog.addEventListener('image-preview-zoom', event => { $id('image-preview-zoom-value').textContent = `${Math.round(event.detail*100)}%`; position(); });
    $id('image-preview-zoom-out').onclick = () => { finishMode(); zoom.zoom(1/1.25); };
    $id('image-preview-zoom-in').onclick = () => { finishMode(); zoom.zoom(1.25); };
    window.addEventListener('resize', position);
    image.parentElement.addEventListener('wheel', event => { if (mode) { event.preventDefault(); event.stopImmediatePropagation(); } }, { capture: true, passive: false });
    $id('image-preview-save').onclick = async () => { if (!await prepare()) return; const token = generation; try { const result = await bridge.saveEditedImage({ dataUrl: canvas.toDataURL('image/png') }); if (token === generation && result?.saved) status('图片已保存'); } catch (error) { if (token === generation) notify(`保存失败：${error.message || error}`, true); } };
    $id('image-preview-open').onclick = async () => { if (!await prepare()) return; const token = generation; try { await bridge.openEditedImage({ dataUrl: canvas.toDataURL('image/png') }); } catch (error) { if (token === generation) notify(`打开失败：${error.message || error}`, true); } };
    $id('image-preview-side').onclick = async () => { if (!await prepare()) return; const token = generation; try { if (typeof openSide !== 'function') throw new Error('侧面板不可用'); await openSide(canvas.toDataURL('image/png')); if (token === generation) dialog.close(); } catch (error) { if (token === generation) notify(`打开侧面板失败：${error.message || error}`, true); } };
    bar.addEventListener('click', async event => {
      const button = event.target.closest('[data-image-tool]'); if (!button || !await prepare()) return;
      const action = button.dataset.imageTool;
      if (action === 'undo') { const previous = history.pop(); if (!previous) { status('没有可撤销的操作'); return; } finishMode(); const token = generation, restore = new Image(); bar.querySelectorAll('button').forEach(b => { b.disabled = true; }); try { await new Promise((resolve, reject) => { restore.onload = resolve; restore.onerror = reject; restore.src = previous; }); if (token !== generation) return; canvas.width = restore.width; canvas.height = restore.height; ctx = canvas.getContext('2d'); ctx.drawImage(restore, 0, 0); finishMode(); status('已撤销'); } catch { if (token === generation) { history.push(previous); status('撤销失败'); } } finally { if (token === generation) bar.querySelectorAll('button').forEach(b => { b.disabled = false; }); } return; }
      if (action === 'resize') { finishMode(); $id('image-preview-width').value = canvas.width; $id('image-preview-height').value = canvas.height; $id('image-preview-resize').hidden = false; return; }
      if (action === 'comment') { finishMode(); $id('image-preview-comment').hidden = false; $id('image-preview-comment-text').focus(); return; }
      if (action === 'background') { finishMode(); const token = generation; bar.querySelectorAll('button').forEach(b => { b.disabled = true; }); status('正在移除背景…'); try { const result = await bridge.removeImageBackground({ dataUrl: canvas.toDataURL('image/png') }); if (token !== generation) return; const output = new Image(); await new Promise((resolve, reject) => { output.onload = resolve; output.onerror = reject; output.src = result.dataUrl; }); if (token !== generation) return; if (!output.width || !output.height || output.width * output.height > 16000000) throw new Error('返回图片尺寸无效或过大'); snapshot(); canvas.width = output.width; canvas.height = output.height; ctx = canvas.getContext('2d'); ctx.drawImage(output, 0, 0); finishMode(); status('背景已移除'); } catch (error) { if (token === generation) status(`移除背景失败：${error.message || error}`); } finally { if (token === generation) bar.querySelectorAll('button').forEach(b => { b.disabled = false; }); } return; }
      if (mode === action) { finishMode(); status('编辑已应用到预览副本'); } else activate(action);
    });
    $id('image-preview-comment').onsubmit = event => { event.preventDefault(); comment = $id('image-preview-comment-text').value.trim(); if (!comment) return; $id('image-preview-comment').hidden = true; activate('comment'); };
    $id('image-preview-resize').onsubmit = event => { event.preventDefault(); const w = Number($id('image-preview-width').value), h = Number($id('image-preview-height').value); if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 8192 || h > 8192 || w*h > 16000000) { status('尺寸最多 8192 像素，且不超过 1600 万像素'); return; } snapshot(); const old = document.createElement('canvas'); old.width = canvas.width; old.height = canvas.height; old.getContext('2d').drawImage(canvas, 0, 0); canvas.width = w; canvas.height = h; ctx = canvas.getContext('2d'); ctx.drawImage(old, 0, 0, w, h); $id('image-preview-resize').hidden = true; finishMode(); status('尺寸已调整'); };
    dialog.querySelectorAll('[data-image-cancel]').forEach(button => button.onclick = () => { $id('image-preview-comment').hidden = true; $id('image-preview-resize').hidden = true; });
    canvas.addEventListener('pointerdown', event => { if (!mode || event.button !== 0 || drawing) return; event.preventDefault(); snapshot(); const p = point(event); if (mode === 'comment') { ctx.font = `${Math.max(18, Math.round(canvas.width/40))}px sans-serif`; ctx.lineWidth = Math.max(3,canvas.width/250); ctx.strokeStyle = '#fff'; ctx.strokeText(comment,p.x,p.y); ctx.fillStyle = '#e23535'; ctx.fillText(comment,p.x,p.y); finishMode(); status('评论已合并到预览副本'); return; } drawing = true; pointerId = event.pointerId; canvas.setPointerCapture(pointerId); ctx.save(); ctx.globalCompositeOperation = mode === 'erase' ? 'destination-out' : 'source-over'; ctx.strokeStyle = '#ef4444'; ctx.lineWidth = Math.max(4, canvas.width / (mode === 'erase' ? 35 : 250)); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.lineTo(p.x+.01,p.y+.01); ctx.stroke(); });
    canvas.addEventListener('pointermove', event => { if (!drawing || event.pointerId !== pointerId) return; const p = point(event); ctx.lineTo(p.x,p.y); ctx.stroke(); });
    for (const type of ['pointerup','pointercancel','lostpointercapture']) canvas.addEventListener(type, event => { if (drawing && event.pointerId === pointerId) { drawing = false; pointerId = null; ctx.restore(); } });
  }
  function open() { generation++; if (drawing) { drawing = false; ctx.restore(); } if (canvas && pointerId !== null && canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId); pointerId = null; ready = false; history = []; mode = ''; if (canvas) { canvas.hidden = true; image.style.visibility = ''; dialog.querySelectorAll('[data-image-tool]').forEach(button => { button.disabled = false; button.classList.remove('active'); }); $id('image-preview-comment').hidden = true; $id('image-preview-resize').hidden = true; status('编辑只影响预览副本'); } }
  function close() { generation++; finishMode(); ready = false; history = []; }
  return Object.freeze({ bind, open, close });
})();
