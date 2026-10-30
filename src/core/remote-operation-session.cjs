'use strict';

// Cancels only the current screen operation. The parent task keeps running;
// calls already returned in the same model response cannot immediately resume it.
function createRemoteOperationSession({ onStop = () => {} } = {}) {
  const pending = new Set();
  let currentBatch = null, blockedBatch = null;
  const reason = () => new Error('用户已退出远程操作，本次浏览器操作已取消；后续可重新发起。');
  return Object.freeze({
    observeBatch(batch) { currentBatch = batch || null; },
    async execute(batch, parentSignal, action) {
      parentSignal?.throwIfAborted();
      if (batch && batch === blockedBatch) throw reason();
      currentBatch = batch || null;
      const controller = new AbortController();
      pending.add(controller);
      const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
      try {
        signal.throwIfAborted();
        const result = await action(signal);
        signal.throwIfAborted();
        return result;
      } finally { pending.delete(controller); }
    },
    exit() {
      blockedBatch = currentBatch;
      for (const controller of pending) controller.abort(reason());
      onStop();
    },
  });
}
module.exports = { createRemoteOperationSession };
