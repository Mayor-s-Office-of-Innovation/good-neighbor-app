import { siteManagerRoster } from "./site-managers.js";
import { mapWithConcurrency } from "./concurrency.js";

/**
 * Load the manager directory without exceeding one shared request budget.
 * Program and Site batches run sequentially so their limits do not add up.
 * @param {{ programId: string }[]} programs
 * @param {{ siteId: string, managerMemberships?: any[] }[]} sites
 * @param {{ getProgram: Function, listManagerMemberships: Function, getSite?: Function }} api
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
    async (site) => {
      if (Array.isArray(site.managerMemberships))
        return { site, memberships: site.managerMemberships };
      const memberships =
        (await api.listManagerMemberships(site.siteId)).memberships || [];
      const items = api.getSite
        ? (await api.getSite(site.siteId, true)).items || []
        : [];
      return {
        site,
        memberships: siteManagerRoster(
          items.filter((item) => item.type === "siteUserAssignment"),
          memberships,
        ),
      };
    },
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
