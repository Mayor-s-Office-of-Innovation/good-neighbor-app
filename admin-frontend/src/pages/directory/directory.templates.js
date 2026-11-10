// HTML for the directory tabs and lists. The Program and Site manager pages
// reuse entityList and siteLabel from here, so changes show there too.
import { providerManagerPath } from "../../provider-manager-directory.js";
import { t } from "../../../../frontend/src/i18n/i18n.js";
import {
  defaultProgramManagerFilter,
  matchesProgramManager,
} from "./program-manager-filter.js";
import { escapeHtml } from "../../dom.js";
import { batch311Header, batch311Checkbox } from "./site-311-batch.js";

/**
 * @typedef {import("../../admin-types.js").AdminState} AdminState
 * @typedef {import("../../admin-types.js").AdminProvider} AdminProvider
 */

/**
 * Render the top-level entity directory without fetching every provider record.
 * Sites are intentionally discovered through their provider until a paginated,
 * server-side site directory endpoint is available.
 * @param {AdminState} state
 * @param {{ name: string, id: string }} route
 */
export function directoryView(state, route) {
  const section =
    route.name === "provider-managers"
      ? "provider-managers"
      : route.name.startsWith("manager")
        ? "managers"
        : route.name.startsWith("provider") || route.name === "programs"
          ? "providers"
          : "sites";
  const params = new URLSearchParams(window.location.search);
  const search = (params.get("q") || "").trim();
  const filterParams = {
    manager: defaultProgramManagerFilter(
      state.role,
      state.profile,
      params.get("manager"),
    ),
    department: params.get("department") || "",
    system: params.get("system") || "",
  };
  return `<section class="directory" aria-labelledby="directory-title">
    <div class="page-head">
      <div>
        <h1 id="directory-title" tabindex="-1">${escapeHtml(t("admin.breadcrumb.admin"))}</h1>
        <p class="muted">Manage providers, programs, sites, enrollment, and devices.</p>
      </div>
    </div>
    <form id="directory-search" class="directory-search" role="search">
      <label class="visually-hidden" for="directory-search-input">Search providers, programs, sites, or managers</label>
      <div class="directory-search__controls">
        <wa-input id="directory-search-input" name="q" type="search" value="${escapeHtml(search)}" placeholder="Search providers, programs, sites, or managers" aria-label="Search providers, programs, sites, or managers" pill with-clear><wa-icon name="magnifying-glass" slot="start" aria-hidden="true"></wa-icon></wa-input>
        <button class="btn-link" id="clear-directory-search" type="button" ${search ? "" : "hidden"}>Clear</button>
      </div>
    </form>
    <div id="directory-results">
    ${
      !search
        ? `<nav class="entity-tabs" aria-label="${escapeHtml(t("admin.directory.sections"))}">
      ${directoryTab("sites", "Sites", section, search)}
      ${directoryTab("managers", "Site managers", section, search)}
      ${state.capabilities?.manageProviderManagers ? directoryTab("provider-managers", escapeHtml(t("admin.providerManagers.title")), section, search) : ""}
      ${directoryTab("providers", "Providers & Programs", section, search)}
    </nav>`
        : ""
    }
    ${search && section === "sites" && state.capabilities?.createEntities === true ? batch311Header() : ""}
    ${search && section !== "provider-managers" ? globalDirectorySearch(state, search) : ""}
    ${section === "provider-managers" ? providerManagerDirectoryView(state, search) : ""}
    ${!search && section === "sites" ? siteDirectory(state, filterParams) : ""}
    ${!search && section === "providers" ? providerDirectory(state.providers) : ""}
    ${!search && section === "managers" ? siteManagerDirectory(state, { program: params.get("program") || "", site: params.get("site") || "" }, search) : ""}
    </div>
  </section>`;
}

/** @param {string} kind @param {string} label @param {string} current @param {string} search */
function directoryTab(kind, label, current, search) {
  const query = search ? `?q=${encodeURIComponent(search)}` : "";
  return `<a href="/${kind}${query}" data-route ${kind === current ? 'aria-current="page"' : ""}>${label}</a>`;
}

/** @param {AdminState} state @param {{ manager: string, department: string, system: string }} selected */
function siteDirectory(state, selected) {
  const sites = state.sites.filter((site) => site.status !== "inactive");
  const managers = new Map(
    state.programManagers.map((manager) => [
      `id:${manager.userId}`,
      {
        value: `id:${manager.userId}`,
        name:
          manager.name ||
          [manager.firstName, manager.lastName].filter(Boolean).join(" "),
      },
    ]),
  );
  if (state.role === "compliance-manager" && state.profile) {
    const value = defaultProgramManagerFilter(state.role, state.profile, null);
    managers.set(value, {
      value,
      name:
        [state.profile.firstName, state.profile.lastName]
          .filter(Boolean)
          .join(" ") || state.profile.email,
    });
  }
  // Keep legacy name-based filter links and sites without directory IDs usable.
  for (const site of sites) {
    const name = site.oversight?.cityProgramManager;
    if (
      name &&
      ![...managers.values()].some((manager) => manager.name === name)
    )
      managers.set(name, { value: name, name });
  }
  if (
    selected.manager &&
    !selected.manager.startsWith("id:") &&
    !managers.has(selected.manager)
  ) {
    managers.set(selected.manager, {
      value: selected.manager,
      name: selected.manager,
    });
  }
  const options = (field) =>
    [
      ...new Set(sites.map((site) => site.oversight?.[field]).filter(Boolean)),
    ].sort((a, b) => a.localeCompare(b));
  const filtered = sites
    .filter(
      (site) =>
        matchesProgramManager(site, selected.manager) &&
        (!selected.department ||
          site.oversight?.managingCityDepartment === selected.department) &&
        (!selected.system ||
          site.oversight?.managingSystemOfCare === selected.system),
    )
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  return `<section class="site-directory" aria-labelledby="sites-title">
    <div class="panel__head">
      <div>
        <h2 class="visually-hidden" id="sites-title">Sites</h2>
        <p class="muted">${filtered.length} ${filtered.length === 1 ? "site" : "sites"}</p>
      </div>
      <a class="btn-link" href="/sites/new" data-route>Add new site</a>
    </div>
    ${state.capabilities.createEntities === true ? batch311Header() : ""}
    <form id="site-directory-filters" class="directory-filters" aria-label="Filter sites">
      <wa-select name="manager" aria-label="All program managers" placeholder="All program managers" value="${escapeHtml(selected.manager)}" size="s" pill><wa-option value="">All program managers</wa-option>${[
        ...managers.values(),
      ]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(
          (manager) =>
            `<wa-option value="${escapeHtml(manager.value)}">${escapeHtml(manager.name)}</wa-option>`,
        )
        .join("")}</wa-select>
      ${filterSelect("department", "All departments", options("managingCityDepartment"), selected.department)}
      ${filterSelect("system", "All systems of care", options("managingSystemOfCare"), selected.system)}
    </form>
    ${
      filtered.length
        ? `<ul class="site-directory-list">${filtered
            .map((site) => {
              const managerName = (site.managerMemberships || [])
                .map((member) => member.name)
                .filter(Boolean)
                .join(", ");
              const manager = managerName || "Site manager not assigned";
              const program = state.programs.find(
                (program) => program.programId === site.leadProgramId,
              );
              const leadProgramName = program?.name || site.programName;
              const providerId = site.providerId || program?.providerId;
              const providerName =
                state.providers.find(
                  (provider) => provider.providerId === providerId,
                )?.name ||
                site.providerName ||
                program?.providerName;
              const description = [
                ["hand-holding-heart", providerName],
                ["puzzle-piece", leadProgramName || "No lead program assigned"],
                ["users", manager],
              ]
                .filter(([, label]) => Boolean(label))
                .map(
                  ([icon, label]) =>
                    `<span class="site-directory-meta__item"><wa-icon name="${icon}" aria-hidden="true"></wa-icon><span>${escapeHtml(label)}</span></span>`,
                )
                .join(
                  '<span class="site-directory-meta__separator" aria-hidden="true">·</span>',
                );
              const siteUrl = `/sites/${encodeURIComponent(site.siteId)}`;
              return `<li><div class="site-directory-row site-directory-row--actions"><a class="site-directory-row__main" href="${siteUrl}" data-route><span class="site-directory-row__text"><strong>${escapeHtml(site.name || site.siteName || site.siteId)}</strong><span class="site-directory-meta">${description}</span></span><span class="site-directory-row__caret" aria-hidden="true">›</span></a><div class="site-directory-row__actions">${batch311Checkbox(state, site)}<a class="btn-secondary" href="${siteUrl}?section=compliance" data-route>${escapeHtml(t("admin.sites.updatePerimeterChecks"))}</a><a class="btn-secondary" href="${siteUrl}?section=access" data-route>${escapeHtml(t("admin.sites.giveAppAccess"))}</a></div></div></li>`;
            })
            .join("")}</ul>`
        : '<p class="empty-state">No sites match these filters.</p>'
    }
  </section>`;
}

/** @param {string} name @param {string} label @param {string[]} values @param {string} selected */
function filterSelect(name, label, values, selected) {
  return `<wa-select name="${name}" aria-label="${escapeHtml(label)}" placeholder="${escapeHtml(label)}" value="${escapeHtml(selected)}" size="s" pill><wa-option value="">${escapeHtml(label)}</wa-option>${values.map((value) => `<wa-option value="${escapeHtml(value)}">${escapeHtml(value)}</wa-option>`).join("")}</wa-select>`;
}

/** @param {AdminState} state @param {{ program: string, site: string }} selected @param {string} search */
function siteManagerDirectory(state, selected, search) {
  const managers = state.siteManagers.filter((manager) => {
    const matchesSearch =
      !search ||
      [
        manager.firstName,
        manager.lastName,
        manager.email,
        manager.programName,
        ...(manager.assignedSites || []).map((site) => site.siteName),
      ].some((value) =>
        String(value || "")
          .toLocaleLowerCase()
          .includes(search.toLocaleLowerCase()),
      );
    return (
      matchesSearch &&
      (!selected.program || manager.programId === selected.program) &&
      (!selected.site ||
        (manager.assignedSites || []).some(
          (site) => site.siteId === selected.site,
        ))
    );
  });
  const programs = state.programs
    .filter((program) => program.status !== "inactive")
    .sort((a, b) => a.name.localeCompare(b.name));
  const sites = state.sites
    .filter((site) => site.status !== "inactive")
    .sort((a, b) => siteLabel(a).localeCompare(siteLabel(b)));
  return `<section class="site-directory" aria-labelledby="managers-title">
    <div class="panel__head">
      <div><h2 class="visually-hidden" id="managers-title">Site managers</h2><p class="muted">${managers.length} ${managers.length === 1 ? "manager" : "managers"}</p></div>
      <a class="btn-link" href="/managers/new" data-route>${escapeHtml(t("admin.managers.addSiteManager"))}</a>
    </div>
    <form id="manager-directory-filters" class="directory-filters" aria-label="Filter site managers">
      ${objectFilterSelect("program", "All programs", programs, selected.program, "programId", "name")}
      ${objectFilterSelect("site", "All sites", sites, selected.site, "siteId", "name")}
    </form>
    ${
      managers.length
        ? `<ul class="site-directory-list">${managers
            .map((manager) => {
              const sitesLabel =
                (manager.assignedSites || [])
                  .map((site) => site.siteName)
                  .join(", ") || "No site assigned";
              return `<li><a class="site-directory-row" href="/managers/${encodeURIComponent(manager.userId)}" data-route><span class="site-directory-row__text"><strong>${escapeHtml(`${manager.firstName} ${manager.lastName}`.trim())}</strong><span>${escapeHtml(manager.programName)} · ${escapeHtml(sitesLabel)}</span></span><span class="site-directory-row__caret" aria-hidden="true">›</span></a></li>`;
            })
            .join("")}</ul>`
        : '<p class="empty-state">No site managers match these filters.</p>'
    }
  </section>`;
}

function objectFilterSelect(name, label, values, selected, valueKey, labelKey) {
  return `<wa-select name="${name}" aria-label="${escapeHtml(label)}" placeholder="${escapeHtml(label)}" value="${escapeHtml(selected)}" size="s" pill><wa-option value="">${escapeHtml(label)}</wa-option>${values.map((item) => `<wa-option value="${escapeHtml(item[valueKey])}">${escapeHtml(item[labelKey] || siteLabel(item))}</wa-option>`).join("")}</wa-select>`;
}

/** @param {AdminState} state @param {string} query */
function globalDirectorySearch(state, query) {
  const needle = query.trim().toLocaleLowerCase();
  const includes = (...values) =>
    values.some((value) =>
      String(value || "")
        .toLocaleLowerCase()
        .includes(needle),
    );
  const sites = state.sites.filter((site) =>
    includes(
      site.name,
      site.address,
      state.programs.find((program) => program.programId === site.leadProgramId)
        ?.name || site.programName,
      site.providerName,
      site.oversight?.cityProgramManager,
      site.oversight?.managingCityDepartment,
      site.oversight?.managingSystemOfCare,
    ),
  );
  const programs = state.programs.filter((program) =>
    includes(program.name, program.providerName),
  );
  const providers = state.providers.filter((provider) =>
    includes(provider.name),
  );
  const managers = state.siteManagers.filter((manager) =>
    includes(
      `${manager.firstName || ""} ${manager.lastName || ""}`.trim(),
      manager.email,
      manager.programName,
      ...(manager.assignedSites || []).map((site) => site.siteName),
    ),
  );
  return `<section class="panel" aria-labelledby="directory-results-title"><h2 id="directory-results-title">${escapeHtml(t("admin.directory.results", { query }))}</h2>
    <p role="status">${escapeHtml(t(state.managerSearchFailed ? "admin.directory.managerError" : !state.managerDirectoryLoaded ? "admin.directory.managerLoading" : "admin.directory.resultCount", { count: sites.length + programs.length + providers.length + managers.length }))}</p>
    ${searchResultList(
      "Sites",
      sites,
      (site) => `/sites/${encodeURIComponent(site.siteId)}`,
      (site) => site.name || site.siteName,
    )}
    ${searchResultList(
      "Programs",
      programs,
      (program) => `/programs/${encodeURIComponent(program.programId)}`,
      (program) =>
        program.providerName
          ? `${program.name} — ${program.providerName}`
          : program.name,
    )}
    ${searchResultList(
      "Providers",
      providers,
      (provider) => `/providers/${encodeURIComponent(provider.providerId)}`,
      (provider) => provider.name,
    )}
    ${searchResultList(
      t("admin.directory.managers"),
      managers,
      (manager) => `/managers/${encodeURIComponent(manager.userId)}`,
      (manager) =>
        `${manager.firstName || ""} ${manager.lastName || ""}`.trim() ||
        manager.email,
    )}
  </section>`;
}

/** @param {string} title @param {any[]} items @param {(item: any) => string} href @param {(item: any) => string} label */
function searchResultList(title, items, href, label) {
  return items.length
    ? `<section class="search-result-group"><h3>${title}</h3>${entityList(items, href, label, () => "", "")}</section>`
    : "";
}

/** @param {AdminState} state */
/** @param {AdminProvider[]} providers */
function providerDirectory(providers) {
  const active = providers
    .filter((provider) => provider.status !== "inactive")
    .sort((a, b) => a.name.localeCompare(b.name));
  return `<section class="site-directory" aria-labelledby="providers-title">
    <div class="panel__head">
      <div><h2 class="visually-hidden" id="providers-title">Providers &amp; Programs</h2>
      <p class="muted">Open a provider to see its associated programs</p>
      <p class="muted">${active.length} ${active.length === 1 ? "provider" : "providers"}</p></div>
      <a class="btn-link" href="/providers/new" data-route>Add new provider</a>
    </div>
    ${active.length ? `<ul class="site-directory-list">${active.map((provider) => `<li><a class="site-directory-row" href="/providers/${encodeURIComponent(provider.providerId)}" data-route><span class="site-directory-row__text"><strong>${escapeHtml(provider.name)}</strong><span>Provider</span></span><span class="site-directory-row__caret" aria-hidden="true">›</span></a></li>`).join("")}</ul>` : '<p class="empty-state">No providers have been added.</p>'}
  </section>`;
}

/**
 * @param {any[]} items
 * @param {(item: any) => string} href
 * @param {(item: any) => string} title
 * @param {(item: any) => string} detail
 * @param {string} emptyMessage
 */
export function entityList(items, href, title, detail, emptyMessage) {
  if (!items.length)
    return `<p class="empty-state">${escapeHtml(emptyMessage)}</p>`;
  return `<ul class="entity-list">${items
    .map(
      (item) => `<li><a class="entity-link" href="${href(item)}" data-route>
        <span>${escapeHtml(title(item))}</span>
        <span class="entity-meta">${escapeHtml(detail(item))}</span>
      </a></li>`,
    )
    .join("")}</ul>`;
}

export function siteLabel(site) {
  return site.name || site.siteName || site.siteId || "Site";
}

function providerManagerDirectoryView(state, search = "") {
  const query = search.toLocaleLowerCase();
  const managers = (state.providerManagerDirectory || []).filter((manager) =>
    [manager.firstName, manager.lastName, manager.providerName, manager.email]
      .join(" ")
      .toLocaleLowerCase()
      .includes(query),
  );
  return `<section class="site-directory" aria-labelledby="provider-manager-directory-title"><h2 class="visually-hidden" id="provider-manager-directory-title">${escapeHtml(t("admin.providerManagers.title"))}</h2><p class="muted directory-count">${escapeHtml(t(managers.length === 1 ? "admin.providerManagers.count.one" : "admin.providerManagers.count.other", { count: managers.length }))}</p>${managers.length ? `<ul class="site-directory-list">${managers.map((manager) => `<li><a class="site-directory-row" href="${providerManagerPath(manager.providerId, manager.membershipId)}" data-route><span class="site-directory-row__text"><strong>${escapeHtml([manager.firstName, manager.lastName].filter(Boolean).join(" ") || manager.name)}</strong><span>${escapeHtml(manager.status === "inactive" ? t("admin.providerManagers.previousProvider", { name: manager.providerName }) : manager.providerName)}</span></span><span class="site-directory-row__caret" aria-hidden="true">›</span></a></li>`).join("")}</ul>` : `<p class="empty-state">${escapeHtml(t("admin.providerManagers.none"))}</p>`}</section>`;
}
