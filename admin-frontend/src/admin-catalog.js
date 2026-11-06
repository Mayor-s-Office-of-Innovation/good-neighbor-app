// Providers, Programs, Sites and oversight lists that several admin pages show.
// Pages change them only through the catalog's methods, so no page keeps a stale copy.
import { adminApi } from "./services/admin-api.js";
import { siteManagerRoster } from "./site-managers.js";
import { upsertRecord } from "./save-feedback.js";

/**
 * @typedef {import("./admin-types.js").AdminProvider} AdminProvider
 * @typedef {import("./admin-types.js").AdminSite} AdminSite
 * @typedef {{ departments: any[], systemsOfCare: any[] }} OversightOptions
 * @typedef {"providers" | "programs" | "oversightOptions" | "programManagers" | "sites"} ListName
 */

/** Lists most admin pages need for pickers and breadcrumbs, read in one batch. @type {readonly ListName[]} */
export const START_UP_LISTS = Object.freeze([
  "providers",
  "programs",
  "oversightOptions",
  "programManagers",
]);

/**
 * Site summaries from the providers directory read, with manager names filled in.
 * @param {{ items: any[] }[]} records
 * @param {any[]} managers
 * @returns {AdminSite[]}
 */
export function directorySites(records, managers) {
  return records
    .map(({ items }) => {
      const site = items.find((item) => item.sk === "#META");
      if (!site) return null;
      const manager = managers.find(
        (item) => item.userId === site.oversight?.cityProgramManagerId,
      );
      if (manager)
        site.oversight = {
          ...site.oversight,
          cityProgramManager:
            [manager.firstName, manager.lastName].filter(Boolean).join(" ") ||
            manager.name ||
            site.oversight.cityProgramManager,
        };
      return {
        ...site,
        complianceManagerIds: items
          .filter(
            (item) =>
              item.type === "siteComplianceManagerAssignment" &&
              item.status === "active",
          )
          .map((item) => item.managerId),
        managerMemberships: siteManagerRoster(
          items.filter((item) => item.type === "siteUserAssignment"),
          items.filter((item) => item.type === "managerMembership"),
        ),
      };
    })
    .filter(Boolean);
}

/** A catalog with its own lists, so each page test can seed lists no other test sees. */
export function createAdminCatalog() {
  /** @type {AdminProvider[]} */
  let providers = [];
  /** @type {any[]} */
  let programs = [];
  /** @type {OversightOptions} */
  let oversightOptions = { departments: [], systemsOfCare: [] };
  /** @type {any[]} */
  let programManagers = [];
  /** @type {AdminSite[]} */
  let sites = [];
  // Stays false if the oversight options read fails, so the next page retries it.
  let startUpLoaded = false;
  let sitesLoaded = false;
  /** @type {Promise<void> | null} */
  let pending = null;
  let programManagersStale = false;
  // Site managers, kept here so the managers directory and manager page share one read.
  /** @type {any[]} */
  let managers = [];
  let managersLoaded = false;
  let managersVersion = 0;
  // Bumped by clear(), so a read that finishes after sign-out can't store its lists.
  let generation = 0;
  // Bumped by invalidate(), so a read that started before a save can't mark its lists current.
  let version = 0;
  let pendingVersion = 0;
  // Bumped by each add, update or remove, so a read that predates one reads again.
  let writes = 0;
  let frozen = false;

  /**
   * @template T
   * @param {T} value
   * @returns {T}
   */
  function keep(value) {
    return frozen ? Object.freeze(value) : value;
  }

  /** @param {any} value */
  function keepOptions(value) {
    if (frozen && value) {
      Object.freeze(value.departments);
      Object.freeze(value.systemsOfCare);
    }
    return keep(value);
  }

  /** @param {boolean} includeSites */
  async function load(includeSites) {
    if (pending) {
      const joined = pendingVersion;
      await pending;
      if (joined !== version || (includeSites && !sitesLoaded))
        await load(includeSites);
      return;
    }
    const started = generation;
    const startedVersion = version;
    const run = (async () => {
      let startedWrites;
      let providerList, programList, options, managerList;
      do {
        startedWrites = writes;
        [providerList, programList, options, managerList] = await Promise.all([
          adminApi.listProviders(includeSites),
          adminApi.listPrograms(),
          adminApi.listOversightOptions().catch((error) => {
            if ([401, 403].includes(error.status)) throw error;
            return null;
          }),
          adminApi.listCityProgramManagers(),
        ]);
        if (started !== generation) return;
      } while (startedWrites !== writes);
      providers = keep(providerList.providers || []);
      programs = keep(programList.programs || []);
      programManagers = keep(managerList.programManagers || []);
      programManagersStale = false;
      if (options)
        oversightOptions = keepOptions({
          departments: options.departments || [],
          systemsOfCare: options.systemsOfCare || [],
        });
      if (includeSites)
        sites = keep(directorySites(providerList.sites || [], programManagers));
      if (startedVersion !== version) return;
      // Keep the other lists, but read oversight options again on the next page.
      startUpLoaded = Boolean(options);
      if (includeSites) sitesLoaded = true;
    })();
    pending = run;
    pendingVersion = startedVersion;
    try {
      await run;
    } finally {
      // After clear(), a newer load may own `pending`; leave it in place.
      if (pending === run) pending = null;
    }
  }

  const catalog = {
    get providers() {
      return providers;
    },
    get programs() {
      return programs;
    },
    get oversightOptions() {
      return oversightOptions;
    },
    get programManagers() {
      return programManagers;
    },
    get sites() {
      return sites;
    },
    get managers() {
      return managers;
    },
    get managersLoaded() {
      return managersLoaded;
    },
    get managersVersion() {
      return managersVersion;
    },
    get programManagersStale() {
      return programManagersStale;
    },
    /**
     * Load the lists a page needs, joining a load already running.
     * Any START_UP_LISTS name loads all four, so pages share one batch of reads.
     * @param {readonly ListName[]} names
     * @returns {Promise<void>}
     */
    async ensure(names) {
      const needsSites = names.includes("sites");
      if (startUpLoaded && (!needsSites || sitesLoaded)) return;
      await load(needsSites);
    },
    /**
     * Mark a list out of date. With no name, every list reloads on the next ensure().
     * @param {"programManagers" | "managers"} [name]
     */
    invalidate(name) {
      if (!name || name === "managers") {
        managersLoaded = false;
        managersVersion++;
      }
      if (name === "programManagers") programManagersStale = true;
      if (!name) {
        version++;
        startUpLoaded = sitesLoaded = false;
      }
    },
    /** Drop a manager directory read still running, keeping the loaded list. */
    supersedeManagersLoad() {
      managersVersion++;
    },
    /** @param {any[]} next */
    setManagers(next) {
      managers = keep(next);
    },
    /** @param {number} version the managersVersion the read started at */
    markManagersLoaded(version) {
      if (version === managersVersion) managersLoaded = true;
    },
    /** @param {AdminProvider[]} next */
    setProviders(next) {
      writes++;
      providers = keep(next);
    },
    /** @param {AdminProvider} provider */
    addProvider(provider) {
      writes++;
      providers = keep(upsertRecord(providers, provider, "providerId"));
    },
    /**
     * Inactive providers aren't listed, so a save must not add them.
     * @param {AdminProvider} provider
     */
    updateProvider(provider) {
      writes++;
      providers = keep(
        providers.map((item) =>
          item.providerId === provider.providerId
            ? { ...item, ...provider }
            : item,
        ),
      );
    },
    /** @param {any[]} next */
    setPrograms(next) {
      writes++;
      programs = keep(next);
    },
    /** @param {any} program */
    addProgram(program) {
      writes++;
      programs = keep(upsertRecord(programs, program, "programId"));
    },
    /** @param {any} options */
    setOversightOptions(options) {
      writes++;
      oversightOptions = keepOptions(options);
    },
    /**
     * Add a new department or system of care, keeping the list in name order.
     * @param {"departments" | "systemsOfCare"} key
     * @param {{ name: string }} option
     */
    addOversightOption(key, option) {
      writes++;
      oversightOptions = keepOptions({
        ...oversightOptions,
        [key]: [...oversightOptions[key], option].sort((a, b) =>
          a.name.localeCompare(b.name),
        ),
      });
    },
    /** @param {any[]} next */
    setProgramManagers(next) {
      writes++;
      programManagers = keep(next);
    },
    /**
     * For a fresh read: clears programManagersStale, which setProgramManagers leaves set.
     * @param {any[]} next
     */
    programManagersReloaded(next) {
      writes++;
      programManagers = keep(next);
      programManagersStale = false;
    },
    /** @param {string} userId @param {Record<string, any>} change */
    updateProgramManager(userId, change) {
      writes++;
      programManagers = keep(
        programManagers.map((manager) =>
          manager.userId === userId ? { ...manager, ...change } : manager,
        ),
      );
    },
    /** @param {AdminSite} site */
    addSite(site) {
      writes++;
      sites = keep(upsertRecord(sites, site, "siteId"));
    },
    /**
     * @param {string} siteId
     * @param {Partial<AdminSite> | ((site: AdminSite) => AdminSite)} change
     */
    updateSite(siteId, change) {
      writes++;
      sites = keep(
        sites.map((site) =>
          site.siteId !== siteId
            ? site
            : typeof change === "function"
              ? change(site)
              : { ...site, ...change },
        ),
      );
    },
    /** @param {(site: AdminSite) => AdminSite} change */
    updateSites(change) {
      writes++;
      sites = keep(sites.map(change));
    },
    /** @param {string} siteId */
    removeSite(siteId) {
      writes++;
      sites = keep(sites.filter((site) => site.siteId !== siteId));
    },
    /** Forget every list, as on sign-out. */
    clear() {
      generation++;
      pending = null;
      providers = keep([]);
      programs = keep([]);
      oversightOptions = keepOptions({ departments: [], systemsOfCare: [] });
      programManagers = keep([]);
      sites = keep([]);
      managers = keep([]);
      startUpLoaded = sitesLoaded = programManagersStale = false;
      managersLoaded = false;
      // Bumped, not reset, so a manager read from before clear() can't mark the list loaded.
      managersVersion++;
    },
    /**
     * Set lists in memory as loaded, so a page test sends no start-up reads.
     * Lists left out stay unloaded, as do Sites unless given.
     * @param {{ providers?: AdminProvider[], programs?: any[], oversightOptions?: OversightOptions, programManagers?: any[], sites?: AdminSite[] }} lists
     */
    seed(lists) {
      catalog.clear();
      // Copies, since freezing must not reach the caller's own arrays.
      providers = keep([...(lists.providers || [])]);
      programs = keep([...(lists.programs || [])]);
      programManagers = keep([...(lists.programManagers || [])]);
      if (lists.oversightOptions)
        oversightOptions = keepOptions({
          departments: [...lists.oversightOptions.departments],
          systemsOfCare: [...lists.oversightOptions.systemsOfCare],
        });
      startUpLoaded = Boolean(
        lists.providers &&
          lists.programs &&
          lists.oversightOptions &&
          lists.programManagers,
      );
      if (lists.sites) {
        sites = keep([...lists.sites]);
        sitesLoaded = true;
      }
    },
    /** Freeze lists stored from now on, so a test catches a page writing to one directly. */
    freezeLists(on = true) {
      frozen = on;
    },
  };
  return catalog;
}

/** @typedef {ReturnType<typeof createAdminCatalog>} AdminCatalog */
