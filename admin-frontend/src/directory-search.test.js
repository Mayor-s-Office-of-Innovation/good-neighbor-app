import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
const catalog = JSON.parse(
  readFileSync(
    new URL("../../frontend/src/i18n/catalogs/en.json", import.meta.url),
    "utf8",
  ),
);
const t = (key, values = {}) =>
  catalog[key].replace(/\{(\w+)\}/g, (_, name) => String(values[name]));
import { escapeHtml } from "./dom.js";
import { primaryProgramStaffId } from "./program-staff.js";

// Exercise the real view functions without booting the custom element or CSS imports.
const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");
function viewFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf("\n}\n", start) + 3;
  return source.slice(start, end);
}
function directory(url) {
  const context = vm.createContext({
    window: { location: new URL(url, "https://admin.example") },
    URLSearchParams,
    t,
    escapeHtml,
    defaultProgramManagerFilter: (_role, _profile, selected) => selected || "",
    siteDirectory: (_state, filters) => JSON.stringify(filters),
    providerDirectory: () => "provider-directory",
    siteManagerDirectory: (_state, filters) => JSON.stringify(filters),
    entityList: (items, href, label) =>
      items
        .map((item) => `<a href="${href(item)}">${escapeHtml(label(item))}</a>`)
        .join(""),
  });
  vm.runInContext(
    [
      "directoryView",
      "directoryTab",
      "globalDirectorySearch",
      "searchResultList",
    ]
      .map(viewFunction)
      .join("\n"),
    context,
  );
  return (state) =>
    context.directoryView(state, {
      name: new URL(url, "https://admin.example").pathname.slice(1),
    });
}
const state = {
  providers: [],
  programs: [],
  sites: [],
  managerDirectoryLoaded: true,
  siteManagers: [
    {
      userId: "m1",
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.org",
      programName: "Outreach",
      assignedSites: [{ siteName: "Gubbio" }],
    },
  ],
};

test("every directory tab enters shared search, including manager full names and assignments", () => {
  for (const section of ["sites", "providers", "managers"]) {
    for (const query of [
      "Jane Doe",
      "Gubbio",
      "jane@example.org",
      "Outreach",
    ]) {
      const html = directory(`/${section}?q=${encodeURIComponent(query)}`)(
        state,
      );
      assert.doesNotMatch(html, /class="entity-tabs"/);
      assert.match(html, /href="\/managers\/m1"/);
      assert.ok(html.includes(t("admin.directory.results", { query })));
    }
  }
});

test("no matches still hides navigation and reports zero results", () => {
  const html = directory("/sites?q=missing")(state);
  assert.doesNotMatch(html, /class="entity-tabs"/);
  assert.ok(html.includes(t("admin.directory.resultCount", { count: 0 })));
});

test("removing only q restores the original tab and its filters", () => {
  for (const [section, filters] of [
    ["sites", "manager=m1&department=Health&system=Care"],
    ["managers", "program=p1&site=s1"],
    ["providers", ""],
  ]) {
    const url = new URL(`https://admin.example/${section}?${filters}&q=Jane`);
    assert.doesNotMatch(directory(url.href)(state), /class="entity-tabs"/);
    url.searchParams.delete("q");
    const html = directory(url.href)(state);
    assert.ok(
      html.includes(`href="/${section}" data-route aria-current="page"`),
    );
    for (const [key, value] of url.searchParams)
      assert.ok(html.includes(`"${key}":"${value}"`));
    assert.doesNotMatch(html, /id="directory-results-title"/);
  }
});

test("manager loading and failure do not imply a complete empty search", () => {
  for (const [managerSearchFailed, key] of [
    [false, "admin.directory.managerLoading"],
    [true, "admin.directory.managerError"],
  ]) {
    const html = directory("/sites?q=missing")({
      ...state,
      managerDirectoryLoaded: false,
      managerSearchFailed,
    });
    assert.ok(html.includes(t(key)));
    assert.ok(!html.includes(t("admin.directory.resultCount", { count: 0 })));
  }
});

test("clearing a manager search before loading finishes refreshes the restored directory", async () => {
  const start = source.indexOf("  async loadSearchManagers() {");
  const end = source.indexOf("\n  async loadSiteManagers", start);
  const input = { value: "", updateComplete: Promise.resolve() };
  const context = vm.createContext({
    URLSearchParams,
    location: { search: "?program=p1&site=s1" },
    currentRoute: () => ({ name: "managers" }),
    document: { activeElement: null },
    input,
  });
  const Subject = vm.runInContext(
    `(class {
    ${source.slice(start, end)}
    state = { managerDirectoryLoaded: false };
    renders = 0;
    async loadSiteManagers() { this.state.managerDirectoryLoaded = true; }
    querySelector() { return input; }
    render() { this.renders++; }
  })`,
    context,
  );
  const subject = new Subject();
  await subject.loadSearchManagers();
  assert.equal(subject.renders, 1);
  assert.equal(subject.state.managerDirectoryLoaded, true);
});

test("program results open the specific program, retaining provider context only in the label", () => {
  for (const providerName of ["The Gubbio Project", ""]) {
    const html = directory("/sites?q=Safe")({
      ...state,
      programs: [
        {
          programId: "program/1",
          providerId: "provider1",
          name: "Safe Sleeping Drop-In",
          providerName,
        },
      ],
    });
    assert.match(html, /href="\/programs\/program%2F1"/);
    assert.doesNotMatch(html, /href="\/providers\/provider1"/);
    assert.doesNotMatch(html, /Open provider/);
    assert.ok(
      html.includes(
        providerName
          ? `Safe Sleeping Drop-In — ${providerName}`
          : "Safe Sleeping Drop-In",
      ),
    );
  }
});

test("new program asks to add a staff member without the redundant contact label", () => {
  const context = vm.createContext({
    window: { location: new URL("https://admin.example/programs/new") },
    URLSearchParams,
    t,
    escapeHtml,
    formInput: () => "",
    phoneInput: () => "",
  });
  vm.runInContext(viewFunction("newProgramView"), context);
  const html = context.newProgramView({ providers: [] });
  assert.ok(
    html.includes(`<legend>${t("admin.programs.addStaffMember")}</legend>`),
  );
  assert.doesNotMatch(html, /Assign staff|Add the first staff contact/);
});

test("program roster shows all active staff and named assignments, with add restricted by capability", () => {
  const context = vm.createContext({
    t,
    escapeHtml,
    entityList: () => "",
    entityBreadcrumb: () => "",
    primaryProgramStaffId,
    phoneWithExtension: () => "",
    programStaffEditDialog: () => "",
    programStaffDialog: () => "staff-dialog",
    siteLabel: (site) => site.name,
  });
  vm.runInContext(viewFunction("programView"), context);
  const program = {
    programId: "p1",
    name: "Outreach",
    providerId: "v1",
    users: [
      {
        firstName: "Amy",
        lastName: "Lee",
        siteManager: false,
        assignedSites: [],
      },
      {
        firstName: "Sam",
        lastName: "Lee",
        assignedSites: [{ siteId: "s/1", name: "Mission" }],
      },
      { firstName: "Inactive", status: "inactive" },
    ],
  };
  for (const canAdd of [true, false]) {
    const html = context.programView(program, canAdd);
    assert.match(html, /Amy Lee/);
    assert.match(html, /Sam Lee/);
    assert.doesNotMatch(html, /Inactive/);
    assert.ok(html.includes(t("admin.programs.noAssignedSites")));
    assert.match(html, /href="\/sites\/s%2F1" data-route>Mission/);
    assert.equal(html.includes('id="add-program-staff"'), canAdd);
  }
});

test("breadcrumbs identify each entity and link only known parents", () => {
  const context = vm.createContext({ t, escapeHtml });
  vm.runInContext(viewFunction("entityBreadcrumb"), context);
  const site = {
    providerId: "provider/1",
    providerName: "Provider & Co",
    leadProgramId: "p1",
    programName: "Outreach",
  };
  const html = context.entityBreadcrumb("site", site);
  assert.match(html, /href="\/providers\/provider%2F1"/);
  assert.match(html, /Provider &amp; Co/);
  assert.match(html, /href="\/programs\/p1"/);
  assert.match(html, /aria-current="page">Site/);
  assert.match(
    context.entityBreadcrumb("program", site),
    /aria-current="page">Program/,
  );
  assert.match(
    context.entityBreadcrumb("provider", {}),
    /aria-current="page">Provider/,
  );
  assert.doesNotMatch(
    context.entityBreadcrumb("site", {}),
    /entity-breadcrumb__parent/,
  );
});

test("site manager breadcrumbs link the associated program and manager directory", () => {
  const context = vm.createContext({ t, escapeHtml });
  vm.runInContext(viewFunction("entityBreadcrumb"), context);
  const html = context.entityBreadcrumb("manager", { programId: "p/1" }, [
    {
      programId: "p/1",
      name: "Outreach",
      providerId: "v1",
      providerName: "Provider",
    },
  ]);
  assert.match(html, /href="\/managers"/);
  assert.match(html, /href="\/programs\/p%2F1" data-route>Outreach/);
  assert.match(html, /href="\/providers\/v1"/);
  assert.match(html, /aria-current="page">Site manager/);
});
