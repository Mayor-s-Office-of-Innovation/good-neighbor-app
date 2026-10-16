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
