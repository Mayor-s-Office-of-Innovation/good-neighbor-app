// What Insights keeps between its pages while one dashboard is open. Held
// by the Insights page, which the app keeps until a new sign-in reloads it.
import { adminApi } from "../../services/admin-api.js";
import { createReportJobs } from "./report-job.js";

/** @typedef {{ value: string, label: string }} Option */
/** @typedef {{ managerId: Option[], providerId: Option[], department: Option[] }} FilterOptions */
/** @typedef {{ managerId: Map<string, string>, providerId: Map<string, string> }} Names */

/** @param {Map<string, string>} names @param {{ value: string }[]} values */
const optionsFor = (names, values) =>
  values
    .map(({ value }) => ({ value, label: names.get(value) ?? value }))
    .sort((a, b) => a.label.localeCompare(b.label));

/** From Manage's lists, so the reporting data needn't hold names. @returns {Promise<{ names: Names, complete: boolean }>} */
async function loadNames() {
  let complete = true;
  /** @param {Promise<any>} read @param {string} field */
  const listed = (read, field) =>
    read
      .then((reply) => reply[field] ?? [])
      .catch(() => {
        complete = false;
        return [];
      });
  const [providers, managers] = await Promise.all([
    listed(adminApi.listProviders(), "providers"),
    listed(adminApi.listCityProgramManagers(), "programManagers"),
  ]);
  return {
    complete,
    names: {
      providerId: new Map(
        providers.map(
          (/** @type {any} */ p) =>
            /** @type {[string, string]} */ ([
              p.providerId,
              p.name || p.providerId,
            ]),
        ),
      ),
      managerId: new Map(
        managers.map(
          (/** @type {any} */ m) =>
            /** @type {[string, string]} */ ([
              m.userId,
              [m.firstName, m.lastName].filter(Boolean).join(" ") ||
                m.name ||
                m.userId,
            ]),
        ),
      ),
    },
  };
}

export function createInsightsSession() {
  /** @type {Promise<{ names: Names, complete: boolean }> | null} */
  let names = null;
  /** @type {Promise<{ options: FilterOptions, names: Names }> | null} */
  let filters = null;
  const session = {
    reportJobs: createReportJobs({ api: adminApi }),
    /**
     * For the way back. `alsoPath` is that Overview at the Site's period.
     * @type {{ path: string, siteId: string, pages: string[], alsoPath: string }}
     */
    overview: { path: "", siteId: "", pages: [], alsoPath: "" },
    /** @returns {Promise<Names>} */
    names() {
      return session.namesRead().then(({ names: found }) => found);
    },
    /** A partial read is used now and read again, so an outage doesn't leave IDs all session. */
    namesRead() {
      names ??= loadNames().then((read) => {
        if (!read.complete) names = null;
        return read;
      });
      return names;
    },
    /** @returns {Promise<{ options: FilterOptions, names: Names }>} */
    filterOptions() {
      // Dropped on failure, so the next page open asks again.
      filters ??= Promise.all([
        adminApi.reportingScopeOptions(),
        session.namesRead(),
      ]).then(
        ([scope, { names: found, complete }]) => {
          if (!complete) filters = null;
          const groups = scope.groups ?? {};
          return {
            names: found,
            options: {
              managerId: optionsFor(found.managerId, groups.managerId ?? []),
              providerId: optionsFor(found.providerId, groups.providerId ?? []),
              department: optionsFor(new Map(), groups.department ?? []),
            },
          };
        },
        (err) => {
          filters = null;
          throw err;
        },
      );
      return filters;
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
  page.insightsSession ??= createInsightsSession();
  return page.insightsSession;
}
