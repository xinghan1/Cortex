const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const validScale = value => Number.isInteger(value) && value >= 80 && value <= 160 && value % 10 === 0;
const DEFAULT_CONTEXT_COMPRESSION_TRIGGER_TOKENS = 850000;
const validContextTrigger = value => Number.isInteger(value) && value >= 1000 && value <= 16000000;
const preferenceError = (message, code) => Object.assign(new Error(message), { code });

class UIPreferences {
  #dir;
  #file;
  #textScale = 100;
  #contextCompressionTriggerTokens = DEFAULT_CONTEXT_COMPRESSION_TRIGGER_TOKENS;
  #initializing;
  #queue = Promise.resolve();

  constructor(options) {
    const dir = typeof options === 'string' ? options : options?.dataDir;
    if (typeof dir !== 'string' || !dir.trim() || dir.includes('\0')) {
      throw preferenceError('界面首选项存储配置无效。', 'UI_PREFERENCES_INVALID_CONFIG');
    }
    this.#dir = path.resolve(dir);
    this.#file = path.join(this.#dir, 'preferences.json');
  }

  get textScale() { return this.#textScale; }
  get contextCompressionTriggerTokens() { return this.#contextCompressionTriggerTokens; }

  snapshot() {
    return { version: 2, textScale: this.#textScale, contextCompressionTriggerTokens: this.#contextCompressionTriggerTokens };
  }

  init() {
    if (!this.#initializing) {
      this.#initializing = (async () => {
        try {
          const value = JSON.parse(await fs.readFile(this.#file, 'utf8'));
          if (value && !Array.isArray(value) && validScale(value.textScale)) {
            if (value.version === 1 && Object.keys(value).length === 2) this.#textScale = value.textScale;
            else if (value.version === 2 && Object.keys(value).length === 3 && validContextTrigger(value.contextCompressionTriggerTokens)) {
              this.#textScale = value.textScale;
              this.#contextCompressionTriggerTokens = value.contextCompressionTriggerTokens;
            }
          }
        } catch {
          // Missing, damaged or unreadable UI preferences must not prevent the
          // application from starting. This file never contains model settings.
        }
        return this;
      })();
    }
    return this.#initializing;
  }

  async setTextScale(scale) {
    if (!validScale(scale)) {
      throw preferenceError('文字缩放必须为 80 至 160 之间、间隔 10 的整数。', 'UI_PREFERENCES_INVALID_SCALE');
    }
    return this.#save({ textScale: scale }, 'textScale', '文字缩放');
  }

  async setContextCompressionTriggerTokens(value) {
    if (!validContextTrigger(value)) {
      throw preferenceError('上下文压缩阈值必须为 1000 至 16000000 之间的整数 Token。', 'UI_PREFERENCES_INVALID_CONTEXT_TRIGGER');
    }
    return this.#save({ contextCompressionTriggerTokens: value }, 'contextCompressionTriggerTokens', '上下文压缩阈值');
  }

  #save(patch, resultKey, label) {
    const operation = this.#queue.then(async () => {
      await this.init();
      const next = { ...this.snapshot(), ...patch };
      const temporary = path.join(this.#dir, `.preferences-${randomUUID()}.tmp`);
      try {
        await fs.mkdir(this.#dir, { recursive: true });
        await fs.writeFile(temporary, JSON.stringify(next) + '\n', { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, this.#file);
        this.#textScale = next.textScale;
        this.#contextCompressionTriggerTokens = next.contextCompressionTriggerTokens;
        return next[resultKey];
      } catch {
        // Filesystem exceptions include absolute paths; expose only a stable,
        // actionable error and keep the previous successfully persisted value.
        throw preferenceError(label + '保存失败，请稍后重试。', 'UI_PREFERENCES_SAVE_FAILED');
      } finally {
        try { await fs.unlink(temporary); } catch { /* Already renamed or unavailable. */ }
      }
    });
    // One failed UI change must not reject every later write in the queue.
    this.#queue = operation.catch(() => {});
    return operation;
  }
}

module.exports = { UIPreferences, DEFAULT_CONTEXT_COMPRESSION_TRIGGER_TOKENS };
