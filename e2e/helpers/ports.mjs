// @ts-check
/*
  Port picking for the Playwright configs. Each config asks for its usual port;
  if something already holds it (a `npm run dev` stack, another worktree's
  suite), the next free port above it is used instead.

  Playwright loads the config in the main process AND in every worker, so the
  choice is stored in process.env on first pick: workers inherit the main
  process's env and read the same value back instead of picking again. Setting
  the variable yourself pins the port.
*/
import { createServer } from "node:net";

/**
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function isFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

/**
 * @param {string} envName e.g. "E2E_APP_PORT"
 * @param {number} preferred
 * @returns {Promise<number>}
 */
export async function e2ePort(envName, preferred) {
  const pinned = process.env[envName];
  if (pinned) return Number(pinned);
  for (let port = preferred; port < preferred + 50; port++) {
    if (await isFree(port)) {
      if (port !== preferred) {
        console.log(`[e2e] port ${preferred} is busy — using ${port} instead`);
      }
      process.env[envName] = String(port);
      return port;
    }
  }
  throw new Error(`[e2e] no free port in ${preferred}–${preferred + 49}`);
}
