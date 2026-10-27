// Keep mutation notifications independent of the polling/UI dependency graph.
const listeners = new Set();

/** @param {() => void} listener */
export function onDuplicateInvalidation(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function invalidateDuplicateIssues() {
  for (const listener of listeners) listener();
}
