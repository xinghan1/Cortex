// Keep application-owned filesystem commits mutually exclusive, including
// overlapping parent/child projects. Callers must not hold this lock while
// waiting for user approval, model/network responses or shell commands.
let pendingCommits = Promise.resolve();

export function withFileCommit(operation) {
  const pending = pendingCommits.then(operation);
  pendingCommits = pending.catch(() => {});
  return pending;
}
