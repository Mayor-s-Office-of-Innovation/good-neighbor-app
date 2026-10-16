import { mapWithConcurrency } from "./concurrency.js";

/**
 * Load the manager directory without exceeding one shared request budget.
 * Program and Site batches run sequentially so their limits do not add up.
 * @param {{ programId: string }[]} programs
 * @param {{ siteId: string }[]} sites
 * @param {{ getProgram: Function, listManagerMemberships: Function }} api
 * @param {number} concurrency
 */
export async function loadManagerDirectory(programs, sites, api, concurrency) {
  const programDetails = await mapWithConcurrency(
    programs,
    concurrency,
    (program) => api.getProgram(program.programId),
  );
  const siteMemberships = await mapWithConcurrency(
    sites,
    concurrency,
    async (site) => ({
      site,
      memberships: (await api.listManagerMemberships(site.siteId)).memberships,
    }),
  );
  return { programDetails, siteMemberships };
}

/** Serialize loads; forced callers await a fresh pass after any current pass.
 * @param {() => Promise<void>} fetchDirectory
 */
export function createDirectoryLoader(fetchDirectory) {
  let active = null;
  let queued = null;
  const start = () => {
    const run = Promise.resolve().then(fetchDirectory);
    active = run;
    const clear = () => {
      if (active === run) active = null;
    };
    run.then(clear, clear);
    return run;
  };
  return {
    get pending() {
      return Boolean(active || queued);
    },
    load(force = false) {
      if (!active) return queued || start();
      if (!force) return queued || active;
      if (!queued) {
        const next = active
          .catch(() => {})
          .then(() => {
            queued = null;
            return start();
          });
        queued = next;
      }
      return queued;
    },
  };
}
