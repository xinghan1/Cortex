'use strict';
(function (root) {
  const bounded = (value, low, high, fallback) => Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : fallback;
  const text = (value, limit = 160) => typeof value === 'string' ? value.slice(0, limit) : '';
  function create({ document = root.document, bridge, notice = () => {}, onConfigure = () => {} }) {
    const view = document.defaultView || root;
    const el = (tag, id, className) => {
      const node = document.createElement(tag);
      if (id) node.id = id;
      if (className) node.className = className;
      return node;
    };
    const overlay = el('aside', 'pet-overlay', 'pet-overlay');
    overlay.hidden = true; overlay.setAttribute('aria-label', '桌面宠物');
    const video = el('video', 'pet-overlay-video', 'pet-overlay-video');
    video.muted = true; video.playsInline = true; video.preload = 'auto'; video.tabIndex = -1;
    video.setAttribute('muted', ''); video.setAttribute('playsinline', '');
    video.setAttribute('aria-hidden', 'true');
    const hit = el('button', 'pet-overlay-hit', 'pet-overlay-hit');
    hit.type = 'button'; hit.setAttribute('aria-haspopup', 'menu');
    const gazeCanvas = el('canvas', 'pet-overlay-gaze', 'pet-overlay-gaze');
    gazeCanvas.hidden = true; gazeCanvas.setAttribute('aria-hidden', 'true');
    const fallback = el('button', 'pet-overlay-fallback', 'pet-overlay-fallback');
    fallback.type = 'button'; fallback.textContent = '🐾'; fallback.hidden = true;
    fallback.setAttribute('aria-label', '打开宠物设置');
    const menu = el('div', 'pet-overlay-menu', 'pet-overlay-menu');
    menu.hidden = true; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', '宠物操作');
    overlay.append(video, gazeCanvas, hit, fallback); document.body.append(overlay, menu);
    let state = { enabled: false, size: 220, x: 1, y: 1, workStatus: true, followCursor: true, packId: '', packs: [] };
    let disposed = false, revision = 0, writeRevision = 0, animationIndex = 0, currentKind = '', currentURL = '', mediaFailed = false;
    let running = false, waiting = false, workspaceId = '', phase = 'idle', drag = null, selectedPack = null;
    let transient = false, actionSequence = 0;
    const tools = new Set(), approvals = new Set(), listeners = new Set();
    const motion = view.matchMedia?.('(prefers-reduced-motion: reduce)');
    const reduced = () => motion?.matches === true;
    const available = kind => selectedPack?.animations?.[kind] || [];
    const gaze = root.ForgePetGaze?.create({ document, video, canvas: gazeCanvas,
      bounds: () => overlay.getBoundingClientRect(),
      onVisible: visible => { if (visible) overlay.classList.add('gaze-active'); else overlay.classList.remove('gaze-active'); },
    });
    function syncGaze() {
      return gaze?.setActive(!disposed && state.followCursor && selectedPack?.id === 'dsh-pet'
        && !overlay.hidden && !document.hidden && !reduced() && !mediaFailed
        && !drag && !transient && phase === 'idle' && !running && !waiting && !tools.size && currentKind === 'idle');
    }
    const inputRegions = [document.querySelector?.('.composer-area'), document.getElementById?.('task-form'), document.getElementById?.('composer-approval')].filter(Boolean);
    const frame = () => {
      const width = Math.max(1, view.innerWidth || document.documentElement?.clientWidth || 1024);
      const height = Math.max(1, view.innerHeight || document.documentElement?.clientHeight || 768);
      let bottom = height - 8;
      for (const region of inputRegions) {
        if (region.hidden) continue;
        const bounds = region.getBoundingClientRect();
        if (!(bounds.width > 0 && bounds.height > 0 && bounds.top < height && bounds.bottom > 0)) continue;
        const style = view.getComputedStyle?.(region);
        if (style?.display === 'none' || style?.visibility === 'hidden') continue;
        bottom = Math.min(bottom, Math.max(0, bounds.top - 8));
      }
      const minY = 46, size = Math.max(0, Math.min(state.size, width - 16, bottom - minY));
      return { size, noRoom: size < 48, minX: 8, minY,
        spanX: Math.max(0, width - size - 16), spanY: Math.max(0, bottom - size - minY) };
    };
    function position() {
      if (disposed) return;
      const { size, noRoom, minX, minY, spanX, spanY } = frame(), wasHidden = overlay.hidden;
      overlay.style.width = `${size}px`; overlay.style.height = `${size}px`;
      overlay.style.left = `${minX + state.x * spanX}px`; overlay.style.top = `${minY + state.y * spanY}px`;
      // Keep the full animation visible while only its character accepts input.
      // The bundled 640x360 clips have large transparent margins; imported pets
      // use their contained picture rectangle rather than that character's data.
      const bundled = selectedPack?.id === 'dsh-pet';
      const width = bundled ? 640 : video.videoWidth || 1;
      const height = bundled ? 360 : video.videoHeight || 1;
      const scale = size / Math.max(width, height);
      const left = (size - width * scale) / 2, top = (size - height * scale) / 2;
      const character = bundled ? { x: 192, y: 28, width: 244, height: 324 } : { x: 0, y: 0, width, height };
      hit.style.left = `${left + character.x * scale}px`; hit.style.top = `${top + character.y * scale}px`;
      hit.style.width = `${character.width * scale}px`; hit.style.height = `${character.height * scale}px`;
      overlay.hidden = !state.enabled || !selectedPack || noRoom;
      if (overlay.hidden) { video.pause(); closeMenu(); }
      else if (wasHidden) playback();
      syncGaze();
    }
    function closeMenu(restore = false) {
      menu.hidden = true; hit.setAttribute('aria-expanded', 'false');
      if (restore && !overlay.hidden) hit.focus?.({ preventScroll: true });
    }
    function playback() {
      const following = syncGaze();
      if (following || overlay.hidden || document.hidden || reduced() || mediaFailed) { video.pause(); return; }
      const result = video.play(); result?.catch?.(() => {});
    }
    function play(kind = 'idle', once = false, force = false) {
      if (disposed || !state.enabled || !selectedPack) return;
      const candidates = available(kind).length ? available(kind) : available('idle');
      if (!candidates.length) { overlay.hidden = true; return; }
      if (!force && currentKind === kind && !transient) { playback(); return; }
      const entry = candidates[animationIndex++ % candidates.length];
      // Only the main process supplies validated, managed local WebM files.
      if (!entry || !/^file:\/\//iu.test(entry.url || '')) return;
      currentKind = kind; transient = once; overlay.dataset.animation = kind;
      video.loop = !once; mediaFailed = false; fallback.hidden = true; video.hidden = false; hit.hidden = false;
      if (currentURL !== entry.url) { currentURL = entry.url; video.src = entry.url; video.load(); }
      else if (force) { try { video.currentTime = 0; } catch {} }
      const CustomEvent = view.CustomEvent || root.CustomEvent;
      if (typeof CustomEvent === 'function') view.dispatchEvent?.(new CustomEvent('synora:pet-action', { detail: { kind, sequence: ++actionSequence } }));
      playback();
    }
    function render() {
      selectedPack = state.packs.find(pack => pack.id === state.packId) || state.packs[0] || null;
      overlay.dataset.packId = selectedPack?.id || '';
      overlay.hidden = !state.enabled || !selectedPack;
      hit.setAttribute('aria-label', `${text(selectedPack?.name) || '宠物'}：左键聊天，拖动移动，右键打开菜单`);
      hit.setAttribute('aria-expanded', String(!menu.hidden));
      position();
      if (overlay.hidden) { video.pause(); closeMenu(); return; }
      play(state.workStatus ? phase : 'idle');
    }
    function update(value) {
      if (disposed || !value || typeof value !== 'object' || !Array.isArray(value.packs)) return;
      const oldPack = state.packId;
      state = { enabled: value.enabled === true, size: bounded(value.size, 80, 600, 220),
        x: bounded(value.x, 0, 1, 1), y: bounded(value.y, 0, 1, 1), workStatus: value.workStatus !== false, followCursor: value.followCursor !== false,
        packId: text(value.packId), packs: value.packs };
      if (state.packId !== oldPack) { currentKind = ''; currentURL = ''; transient = false; }
      render(); for (const listener of listeners) listener(state);
    }
    async function save(patch) {
      if (disposed) return;
      const start = revision, write = ++writeRevision;
      try {
        const next = await bridge.setPet(patch);
        if (!disposed && start === revision && write === writeRevision) update(next?.pet || next);
        return next;
      } catch (error) {
        if (!disposed) notice(text(error?.message || String(error), 500).replace(/^Error invoking remote method ['"][^'"]+['"]:\s*(?:Error:\s*)?/u, ''), true);
        throw error;
      }
    }
    function updatePhase() {
      const next = waiting ? 'waiting' : tools.size ? 'working' : running ? 'thinking' : 'idle';
      if (next === phase) return;
      phase = next; transient = false; if (state.workStatus) play(phase, false, true);
      syncGaze();
    }
    function updateState(value) {
      if (!value || disposed) return;
      if (workspaceId && workspaceId !== value.workspaceId) { tools.clear(); approvals.clear(); }
      workspaceId = value.workspaceId || workspaceId;
      running = value.activeTask?.running === true;
      if (Array.isArray(value.pendingApprovals)) {
        approvals.clear(); for (const approval of value.pendingApprovals) approvals.add(approval.id || 'approval');
      }
      waiting = approvals.size > 0;
      if (!running) tools.clear();
      updatePhase();
    }
    function handleEvent(event) {
      if (disposed || !event) return;
      if (event.type === 'pet-pointer') { gaze?.point(event); return; }
      if (event.type === 'pet-state') { ++revision; update(event.pet); return; }
      if (event.type === 'workspace-activated') { updateState(event.state); return; }
      if (event.workspaceId && workspaceId && event.workspaceId !== workspaceId) return;
      if (event.type === 'state') { updateState(event.state); return; }
      if (event.type === 'run-start') { running = true; waiting = false; tools.clear(); approvals.clear(); updatePhase(); }
      else if (event.type === 'tool-start') { tools.add(event.toolCallId || event.id || event.callId || 'tool'); updatePhase(); }
      else if (event.type === 'tool-result') { tools.delete(event.toolCallId || event.id || event.callId || 'tool'); updatePhase(); }
      else if (event.type === 'approval-request') { approvals.add(event.id || 'approval'); waiting = true; updatePhase(); }
      else if (event.type === 'approval-resolved') { approvals.delete(event.id || 'approval'); waiting = approvals.size > 0; updatePhase(); }
      else if (event.type === 'text-delta' && state.workStatus && !tools.size && !waiting) {
        if (phase !== 'result') { phase = 'result'; transient = false; play('result', false, true); }
      } else if (event.type === 'run-end') {
        running = false; waiting = false; tools.clear(); approvals.clear(); phase = 'idle';
        if (state.workStatus) play(['failed', 'error'].includes(event.status) ? 'error' : event.status === 'stopped' ? 'idle' : 'success', event.status !== 'stopped', true);
      }
      syncGaze();
    }
    function addMenu(label, action, id) {
      const button = el('button', id, 'pet-overlay-menu-item'); button.type = 'button'; button.textContent = label;
      button.setAttribute('role', 'menuitem'); button.addEventListener('click', () => { closeMenu(); action(); }); menu.append(button);
    }
    function openMenu(clientX, clientY) {
      if (disposed || overlay.hidden) return;
      menu.replaceChildren();
      addMenu('摸摸', () => play('clicks', true, true), 'pet-overlay-pat');
      if (available('turn').length) addMenu('转身', () => play('turn', true, true), 'pet-overlay-turn');
      if (available('actions').length) addMenu('写代码', () => play('actions', true, true), 'pet-overlay-action');
      addMenu('重置位置', () => { state.x = state.y = 1; position(); void save({ x: 1, y: 1 }).catch(() => {}); }, 'pet-overlay-reset');
      addMenu('宠物设置', onConfigure, 'pet-overlay-settings');
      addMenu('隐藏宠物', () => void save({ enabled: false }).catch(() => {}), 'pet-overlay-hide');
      menu.hidden = false; hit.setAttribute('aria-expanded', 'true');
      const bounds = menu.getBoundingClientRect();
      menu.style.left = `${bounded(clientX, 8, Math.max(8, (view.innerWidth || 1024) - bounds.width - 8), 8)}px`;
      menu.style.top = `${bounded(clientY, 8, Math.max(8, (view.innerHeight || 768) - bounds.height - 8), 8)}px`;
      menu.children[0]?.focus?.({ preventScroll: true });
    }
    function openChat() {
      if (disposed || overlay.hidden) return;
      closeMenu();
      const CustomEvent = view.CustomEvent || root.CustomEvent;
      if (typeof CustomEvent === 'function') view.dispatchEvent?.(new CustomEvent('synora:pet-chat-open'));
    }
    const pointerDown = event => {
      if (event.button !== 0 || disposed) return;
      closeMenu(); event.preventDefault();
      drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x: state.x, y: state.y, moved: false };
      syncGaze();
      hit.setPointerCapture?.(event.pointerId);
    };
    const pointerMove = event => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      if (!drag.moved) { drag.moved = true; overlay.classList.add('dragging'); play('drag', false, true); }
      const { spanX, spanY } = frame();
      state.x = bounded(drag.x + (spanX ? dx / spanX : 0), 0, 1, drag.x);
      state.y = bounded(drag.y + (spanY ? dy / spanY : 0), 0, 1, drag.y); position();
    };
    const pointerEnd = event => {
      if (!drag || event.pointerId !== drag.id) return;
      const moved = drag.moved; drag = null; overlay.classList.remove('dragging');
      if (hit.hasPointerCapture?.(event.pointerId)) hit.releasePointerCapture(event.pointerId);
      if (moved) { transient = false; play(state.workStatus ? phase : 'idle', false, true); void save({ x: state.x, y: state.y }).catch(() => {}); }
      else if (event.type !== 'pointercancel') openChat();
      syncGaze();
    };
    const contextMenu = event => { event.preventDefault(); openMenu(event.clientX, event.clientY); };
    const keyDown = event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (!event.repeat && !event.isComposing) openChat(); }
      else if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) {
        event.preventDefault(); const bounds = overlay.getBoundingClientRect(); openMenu(bounds.left, bounds.top);
      } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault(); const step = event.shiftKey ? .1 : .02;
        state.x = bounded(state.x + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0), 0, 1, 1);
        state.y = bounded(state.y + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0), 0, 1, 1);
        position(); void save({ x: state.x, y: state.y }).catch(() => {});
      }
    };
    const outside = event => { if (!menu.contains(event.target) && event.target !== hit) closeMenu(); };
    const escape = event => {
      if (!menu.hidden && event.key === 'Escape') { event.preventDefault(); closeMenu(true); }
      else if (!menu.hidden && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault(); const index = [...menu.children].indexOf(document.activeElement);
        menu.children[(index + (event.key === 'ArrowDown' ? 1 : -1) + menu.children.length) % menu.children.length]?.focus?.();
      }
    };
    const ended = () => { if (transient) { transient = false; play(state.workStatus ? phase : 'idle', false, true); } };
    const failed = () => { mediaFailed = true; video.pause(); video.hidden = true; hit.hidden = true; fallback.hidden = false; syncGaze(); };
    const resized = () => { position(); closeMenu(); };
    let layoutFrame = null;
    const scheduleLayout = () => {
      if (disposed || layoutFrame !== null) return;
      layoutFrame = view.requestAnimationFrame(() => {
        layoutFrame = null;
        if (!disposed) resized();
      });
    };
    const visibility = () => playback();
    const motionChanged = () => playback();
    const cursorMoved = event => { if (event.pointerType !== 'touch') gaze?.point({ x: event.clientX, y: event.clientY }); };
    hit.addEventListener('pointerdown', pointerDown); hit.addEventListener('pointermove', pointerMove);
    hit.addEventListener('pointerup', pointerEnd); hit.addEventListener('pointercancel', pointerEnd);
    hit.addEventListener('contextmenu', contextMenu); hit.addEventListener('keydown', keyDown);
    video.addEventListener('loadedmetadata', position);
    video.addEventListener('ended', ended); video.addEventListener('error', failed); video.addEventListener('loadeddata', playback);
    fallback.addEventListener('click', onConfigure); fallback.addEventListener('contextmenu', contextMenu);
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    document.addEventListener('visibilitychange', visibility); view.addEventListener?.('resize', resized);
    // The main process also supplies desktop cursor coordinates. Losing focus
    // or crossing the window edge must not stop a still-visible idle pet.
    document.addEventListener('pointermove', cursorMoved, { passive: true });
    motion?.addEventListener?.('change', motionChanged);
    const layoutObserver = typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(scheduleLayout) : null;
    const layoutRegions = new Set([...inputRegions, document.getElementById?.('message-scroll'), document.querySelector?.('.conversation')].filter(Boolean));
    for (const region of layoutRegions) layoutObserver?.observe(region);
    const unsubscribe = bridge.onEvent?.(handleEvent);
    const start = revision;
    const ready = Promise.resolve().then(() => bridge.petState()).then(next => {
      if (!disposed && revision === start) update(next?.pet || next);
    }).catch(error => { if (!disposed) notice(`宠物设置读取失败：${text(error?.message || String(error), 300)}`, true); });
    return Object.freeze({ ready, update, updateState, handleEvent, set: save,
      snapshot: () => state,
      subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener); },
      destroy() {
        if (disposed) return; disposed = true; drag = null; listeners.clear(); unsubscribe?.();
        document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape);
        document.removeEventListener('visibilitychange', visibility); view.removeEventListener?.('resize', resized);
        document.removeEventListener('pointermove', cursorMoved); gaze?.destroy();
        motion?.removeEventListener?.('change', motionChanged); layoutObserver?.disconnect();
        if (layoutFrame !== null) { view.cancelAnimationFrame(layoutFrame); layoutFrame = null; }
        video.removeEventListener('loadedmetadata', position);
        video.pause(); video.removeAttribute('src'); video.load();
        overlay.remove(); menu.remove();
      },
    });
  }
  root.ForgePetOverlay = Object.freeze({ create });
})(typeof globalThis === 'object' ? globalThis : this);
