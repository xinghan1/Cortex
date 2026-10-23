(() => {
  'use strict';
  const pendingLabel = '正在压缩上下文 · 可能需要几分钟';
  const completedLabels = {
    completed: '上下文已自动压缩', failed: '上下文压缩失败',
    stopped: '上下文压缩已停止', cancelled: '上下文压缩已取消', ended: '上下文压缩已结束',
  };

  function createNotice(status = 'completed') {
    const node = document.createElement('div');
    node.className = 'context-compaction-notice';
    node.dataset.status = status;
    node.setAttribute('role', 'status');
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('class', 'context-compaction-mark');
    icon.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M8 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h9M16 4h3a1 1 0 0 1 1 1v10M9 3h6v3H9V3Zm-1 8h8M8 15h5M17 18h5m-2.5-2.5v5');
    icon.append(path);
    const message = document.createElement('span');
    message.className = 'context-compaction-message';
    message.textContent = completedLabels[status] || completedLabels.ended;
    node.append(icon, message);
    return node;
  }

  function createProgress({ target, block, runId = '' }) {
    const node = createNotice();
    node.className = 'context-compaction-progress';
    node.dataset.status = 'running';
    node.dataset.runId = String(runId);
    node.setAttribute('aria-live', 'polite');
    node.setAttribute('aria-atomic', 'true');
    const message = node.querySelector('.context-compaction-message');
    message.textContent = pendingLabel;
    // The hidden anchor preserves chronology even if a running task is folded
    // or new steering messages arrive while the summary request is pending.
    const anchor = document.createElement('span');
    anchor.className = 'context-compaction-anchor';
    anchor.hidden = true;
    target.append(anchor);
    let settled = false;
    const place = () => {
      if (settled) return;
      if (block && !block.open && block.parentElement) block.after(node);
      else anchor.after(node);
    };
    block?.addEventListener('toggle', place);
    place();
    const dispose = () => {
      settled = true;
      block?.removeEventListener('toggle', place);
      anchor.remove();
    };
    return {
      node, place,
      reconnect(state) {
        if (settled) return;
        const retrying = state && ['waiting', 'retrying'].includes(state.status);
        message.textContent = retrying ? `正在压缩上下文 · 正在重连 ${state.attempt}/${state.maxAttempts}` : pendingLabel;
        if (retrying) node.dataset.reconnect = state.status;
        else delete node.dataset.reconnect;
      },
      finish(status = 'completed') {
        if (settled) return node;
        node.className = 'context-compaction-notice';
        node.dataset.status = status;
        delete node.dataset.reconnect;
        message.textContent = completedLabels[status] || completedLabels.ended;
        anchor.after(node);
        dispose();
        return node;
      },
      remove() { dispose(); node.remove(); },
    };
  }

  globalThis.ForgeContextCompaction = { createNotice, createProgress };
})();
