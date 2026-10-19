import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { ConnectionStore } from '../vendor/siwc/storage.js';
import { ChatGPTError } from '../vendor/siwc/errors.js';

const READ_FAILURES = new Set([
  'storage_decryption_failed', 'storage_encrypted_invalid', 'storage_provider_mismatch', 'storage_invalid',
]);
const MAX_CREDENTIAL_BYTES = 2 * 1024 * 1024;

export function isUnreadableChatGPTStorage(error) { return READ_FAILURES.has(error?.code); }

function recoveryError() {
  return new ChatGPTError('storage_recovery_failed', '无法安全保留原 ChatGPT 凭据文件，本机登录信息未重置。请检查数据目录权限后重试。', true);
}

function sameIdentity(a, b) {
  // Windows path stats may report device 0 while the open handle reports the
  // volume ID. Keep exact bigint inode/birth time and verified real paths.
  const sameDevice = a.dev === b.dev || (process.platform === 'win32' && (a.dev === 0n || b.dev === 0n));
  return sameDevice && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
}
function sameFile(a, b) {
  return sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function samePath(a, b) {
  return process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
}

/** Explicit local logout only. Never called as a consequence of initialization or retrying a read. */
export async function preserveUnreadableChatGPTCredentials({ directory, encryption }) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw recoveryError();
  const store = new ConnectionStore(directory, encryption);
  return store.withLock(async () => {
    // Another process or the OS credential store may have recovered while the
    // caller waited for this same SDK lock. Healthy credentials use normal logout.
    try { await store.read(); return { backupCreated: false }; }
    catch (error) { if (!isUnreadableChatGPTStorage(error)) throw error; }

    let handle, backupDirectory;
    let moved = false;
    try {
      const root = await fs.lstat(directory, { bigint: true });
      if (!root.isDirectory() || root.isSymbolicLink() || !samePath(await fs.realpath(directory), directory)) throw recoveryError();
      const filename = path.join(directory, 'chatgpt-auth.json');
      const before = await fs.lstat(filename, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(MAX_CREDENTIAL_BYTES)) throw recoveryError();
      handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || !sameFile(before, opened)) throw recoveryError();
      const bytes = await handle.readFile();
      if (BigInt(bytes.length) !== opened.size || !sameFile(opened, await handle.stat({ bigint: true })) || !sameFile(opened, await fs.lstat(filename, { bigint: true }))) throw recoveryError();
      await handle.close(); handle = undefined;

      // A freshly created private directory gives the rename a unique empty
      // destination without overwriting an earlier backup, even across processes.
      backupDirectory = await fs.mkdtemp(path.join(directory, '.chatgpt-preserved-'));
      if (process.platform !== 'win32') await fs.chmod(backupDirectory, 0o700);
      const backupRoot = await fs.lstat(backupDirectory, { bigint: true });
      if (!backupRoot.isDirectory() || backupRoot.isSymbolicLink() || !samePath(await fs.realpath(backupDirectory), backupDirectory)
          || !sameIdentity(root, await fs.lstat(directory, { bigint: true })) || !sameFile(opened, await fs.lstat(filename, { bigint: true }))) throw recoveryError();
      await fs.rename(filename, path.join(backupDirectory, 'chatgpt-auth.json'));
      moved = true;
      return { backupCreated: true };
    } catch {
      throw recoveryError();
    } finally {
      await handle?.close().catch(() => {});
      // rmdir never removes nonempty content or follows a substituted directory.
      if (!moved && backupDirectory) await fs.rmdir(backupDirectory).catch(() => {});
    }
  });
}
