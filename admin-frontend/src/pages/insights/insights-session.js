// What Insights keeps between its pages while one dashboard is open. Held by
// <admin-insights-page>, which stays until sign-out or a page reload.
import { START_UP_LISTS, createAdminCatalog } from "../../admin-catalog.js";
import { adminApi } from "../../services/admin-api.js";
import { createReportJobs } from "./report-job.js";

/** @typedef {{ value: string, label: string }} Option */
/** @typedef {{ managerId: Option[], providerId: Option[], department: Option[] }} FilterOptions */
/** @typedef {{ managerId: Map<string, string>, providerId: Map<string, string> }} Names */
/** @typedef {ReturnType<typeof createAdminCatalog>} AdminCatalog */

/** @param {Map<string, string>} names @param {{ value: string }[]} values */
const optionsFor = (names, values) =>
  values
    .map(({ value }) => ({ value, label: names.get(value) ?? value }))
    .sort((a, b) => a.label.localeCompare(b.label));

/** @param {AdminCatalog} catalog @returns {Names} */
const namesIn = (catalog) => ({
  providerId: new Map(
    catalog.providers.map((p) => [p.providerId, p.name || p.providerId]),
  ),
  managerId: new Map(
    catalog.programManagers.map((/** @type {any} */ m) => [
      m.userId,
      [m.firstName, m.lastName].filter(Boolean).join(" ") || m.name || m.userId,
    ]),
  ),
});

/**
 * From Manage's lists, so the reporting data needn't hold names and a Manage edit shows at once.
 * @param {AdminCatalog} catalog
 * @returns {Promise<{ names: Names, complete: boolean }>}
 */
async function readNames(catalog) {
  try {
    await catalog.ensure(START_UP_LISTS);
    // A manager edit marks the list stale without reading it again.
    if (catalog.programManagersStale)
      catalog.programManagersReloaded(
        (await adminApi.listCityProgramManagers()).programManagers ?? [],
      );
    return { names: namesIn(catalog), complete: true };
  } catch (err) {
    // An expired or blocked sign-in must reach the page, not show as IDs.
    if ([401, 403].includes(/** @type {any} */ (err)?.status)) throw err;
    // IDs show for now; the next read asks again.
    return { names: namesIn(catalog), complete: false };
  }
}

/** @param {AdminCatalog} [catalog] <admin-app>'s lists, shared with Manage */
export function createInsightsSession(catalog = createAdminCatalog()) {
  /** @type {Promise<any> | null} */
  let scope = null;
  /** @type {Promise<Option[]> | null} */
  let sites = null;
  // One read gives both the filter groups and every Site, so Overview asks once.
  const scopeRead = () => {
    scope ??= adminApi
      .reportingScopeOptions({ include: "sites" })
      .catch((err) => {
        scope = null;
        throw err;
      });
    return scope;
  };
  const session = {
    reportJobs: createReportJobs({ api: adminApi }),
    /**
     * For the way back. `alsoPath` is that Overview at the Site's period;
     * `selected` holds its picks, which are too long for the URL.
     * @type {{ path: string, siteId: string, selected: string[], alsoPath: string }}
     */
    overview: { path: "", siteId: "", selected: [], alsoPath: "" },
    /** @returns {Promise<Names>} */
    names() {
      return readNames(catalog).then(({ names: found }) => found);
    },
    namesRead() {
      return readNames(catalog);
    },
    /** Labels are rebuilt each time, so renamed Providers and managers show. @returns {Promise<{ options: FilterOptions, names: Names }>} */
    async filterOptions() {
      const [reply, { names: found }] = await Promise.all([
        scopeRead(),
        readNames(catalog),
      ]);
      const groups = reply.groups ?? {};
      return {
        names: found,
        options: {
          managerId: optionsFor(found.managerId, groups.managerId ?? []),
          providerId: optionsFor(found.providerId, groups.providerId ?? []),
          department: optionsFor(new Map(), groups.department ?? []),
        },
      };
    },
    /** Every Site's name, so Overview can say how many Sites there are in all. @returns {Promise<Option[]>} */
    siteOptions() {
      sites ??= scopeRead().then(
        (reply) =>
          (reply.sites ?? [])
            .map((/** @type {any} */ s) => ({
              value: s.siteId,
              label: s.name || s.siteId,
            }))
            .sort((/** @type {Option} */ a, /** @type {Option} */ b) =>
              a.label.localeCompare(b.label),
            ),
        (err) => {
          sites = null;
          throw err;
        },
      );
      return sites;
    },
  };
  return session;
}

/** @typedef {ReturnType<typeof createInsightsSession>} InsightsSession */

/** @param {Element} element a page inside the dashboard @returns {InsightsSession} */
export function sessionOf(element) {
  const page = /** @type {any} */ (element.closest("admin-insights-page"));
  // A page drawn outside the dashboard, as in a template test, gets its own.
  if (!page) return createInsightsSession();
  page.insightsSession ??= createInsightsSession(page.catalog ?? undefined);
  return page.insightsSession;
}
