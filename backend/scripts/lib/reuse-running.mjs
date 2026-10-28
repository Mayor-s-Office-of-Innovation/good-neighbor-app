// Shared "already running? reuse it" step for the local service launchers.
//
// A second stack (the e2e suite beside `npm run dev`, or another worktree) finds
// the shared ports taken. DynamoDB Local and ElasticMQ hold no per-stack state —
// each stack keeps to its own table/queue names — so the second launcher reuses
// the running one instead of crashing, which under `concurrently -k` would tear
// down every other lane. Same pattern as local-minio.mjs and local-sf311.mjs.

import { createServer } from "node:http";

/**
 * Run `probe` against the port. Resolves true when it answers (the caller
 * should then park), false when nothing is listening. Anything else — a
 * squatter that is not the expected service — exits loudly.
 * @param {string} label log prefix, e.g. "ddb"
 * @param {number} port
 * @param {() => Promise<unknown>} probe a cheap call that only the real service answers
 * @returns {Promise<boolean>}
 */
export async function alreadyRunning(label, port, probe) {
  try {
    await probe();
    return true;
  } catch (err) {
    const e = /** @type {any} */ (err);
    const code = e?.code ?? e?.cause?.code ?? e?.errors?.[0]?.code;
    if (code === "ECONNREFUSED") return false;
    console.error(
      `[${label}] port ${port} is held by something else (${e?.name ?? code}: ${e?.message}) — free it and retry`,
    );
    process.exit(1);
  }
}

/**
 * Idle until the stack is torn down. DO NOT exit instead: under
 * `concurrently -k` a lane that exits (even 0) SIGTERMs every other lane.
 * Parks on a real handle, since a bare pending promise does not keep Node alive.
 * @param {string} label
 * @param {number} port
 * @returns {Promise<never>}
 */
export function park(label, port) {
  console.log(
    `[${label}] port ${port} already serves it — reusing (idling while the stack runs)`,
  );
  const handle = createServer(() => {});
  handle.on("error", () => {});
  handle.listen(0, "127.0.0.1");
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
  return new Promise(() => {});
}
