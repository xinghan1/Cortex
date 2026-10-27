const { randomUUID } = require('node:crypto');

// The archive stays intact. A connection change starts a new model-only
// segment, while a fresh native identifier prevents provider-owned history
// from being reopened under a different account.
function selectModelContext(session, { connectionIdentity, catalogKey, provider, accountChanged }) {
  const previous = session.modelContext?.connectionIdentity;
  const oldCatalogKey = session.contextUsage?.connectionKey;
  const changed = session.messages.length > 0 && (previous ? previous !== connectionIdentity
    : accountChanged || !!oldCatalogKey && oldCatalogKey !== catalogKey
      || !!session.contextUsage?.provider && session.contextUsage.provider !== provider);
  if (!previous || changed) {
    session.modelContext = { connectionIdentity, startIndex: changed ? session.messages.length : 0,
      nativeSessionId: changed ? randomUUID() : session.id };
    if (changed) { session.contextCheckpoint = {}; session.contextUsage = {}; }
  }
  return changed;
}
module.exports = { selectModelContext };
