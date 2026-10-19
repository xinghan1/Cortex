const path = require('node:path');

// Only installer builds carry synoraInstalled in their packaged metadata.
// Their data must survive replacement or removal of the executable directory.
function resolveDataDirectory({ override, isPackaged, isInstalled, appDataPath, execPath, projectDir, smoke = false }) {
  if (override) return override;
  if (!isPackaged) return path.join(projectDir, smoke ? '.smoke-data-v16-6' : '.local-data');
  if (isInstalled) return path.join(appDataPath, 'Synora code');
  return path.join(path.dirname(execPath), 'data');
}

module.exports = { resolveDataDirectory };
