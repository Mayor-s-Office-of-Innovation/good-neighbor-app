// A stateful fake of /admin/v1, so specs run the admin dashboard without a backend.
// ADMIN_E2E_COVERAGE_DIR saves each test's V8 coverage of admin-frontend/src.
import { test as base, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * @typedef {{ method: string, path: string, search: string, body: any, headers: Record<string, string> }} AdminRequest
 * @typedef {{ status?: number, json?: any, body?: string, contentType?: string, headers?: Record<string, string>, delay?: Promise<unknown> }} AdminReply
 * @typedef {(request: AdminRequest, match: RegExpExecArray) => AdminReply | undefined | Promise<AdminReply | undefined>} AdminHandler
 */

const coverageDir = process.env.ADMIN_E2E_COVERAGE_DIR;

/** @type {WeakMap<import("@playwright/test").Page, string[]>} */
const mockFailuresByPage = new WeakMap();

export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    /** @type {string[]} */
    const pageErrors = [];
    // The URL names the route that threw, when one test visits several.
    page.on("pageerror", (error) =>
      pageErrors.push(`${page.url()}: ${error.message}`),
    );
    await (coverageDir
      ? withCoverage(coverageDir, page, use, testInfo)
      : use(page));
    // The admin page may hide the 404 a missing route gets, so a mock gap would pass unseen.
    expect(
      mockFailures(page),
      "requests with no mock route or a handler that threw",
    ).toEqual([]);
    // A render that throws can leave the page a test expects empty, so absence checks would pass.
    expect(pageErrors, "uncaught page errors").toEqual([]);
  },
});
export { expect };

/**
 * Requests since the page's last mockAdmin() that no default or scripted route
 * answered, whose scripted handler threw, or whose path wouldn't decode.
 * @param {import("@playwright/test").Page} page
 * @returns {string[]}
 */
export function mockFailures(page) {
  return mockFailuresByPage.get(page) || [];
}

/**
 * Run the test while saving Chromium's V8 coverage for each page load.
 * @param {string} coverageDir
 * @param {import("@playwright/test").Page} page
 * @param {(page: import("@playwright/test").Page) => Promise<void>} use
 * @param {import("@playwright/test").TestInfo} testInfo
 */
async function withCoverage(coverageDir, page, use, testInfo) {
  fs.mkdirSync(coverageDir, { recursive: true });
  let part = 0;
  const save = async () => {
    const entries = (await page.coverage.stopJSCoverage()).filter((entry) =>
      entry.url.includes("/src/"),
    );
    if (!entries.length) return;
    fs.writeFileSync(
      // Retries and repeats share a testId; without them they overwrite each other's files.
      path.join(
        coverageDir,
        `${testInfo.testId}-${testInfo.repeatEachIndex}-${testInfo.retry}-${part++}.json`,
      ),
      JSON.stringify(entries),
    );
  };
  // V8 drops a document's counts when the next loads, so save before goto and reload.
  // Chromium blocks coverage calls during a held load, so location.reload and links still lose them.
  for (const method of /** @type {const} */ (["goto", "reload"])) {
    const navigate = /** @type {(...args: any[]) => Promise<any>} */ (
      page[method].bind(page)
    );
    /** @type {any} */ (page)[method] = async (
      /** @type {any[]} */ ...args
    ) => {
      await save();
      await page.coverage.startJSCoverage({ resetOnNavigation: false });
      return navigate(...args);
    };
  }
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  await use(page);
  await save();
}

/** Synthetic records; every test gets a fresh copy it may change. */
export function adminData() {
  const site = {
    siteId: "s1",
    name: "Example Site",
    siteType: "shelter",
    providerId: "v1",
    providerName: "Example Provider",
    leadProgramId: "p1",
    programName: "Example Program",
    status: "active",
    address: "100 Example St, San Francisco, CA 94103",
    addressParts: {
      streetNumber: "100",
      streetAddress: "Example St",
      secondLine: "",
      city: "San Francisco",
      state: "CA",
      zip: "94103",
    },
    location: { latitude: 37.77, longitude: -122.41 },
    publicContact: { name: "Front Desk", phone: "4155550100" },
    primaryContactUserId: "u1",
    // admin.js normalizeOversight stores names, not IDs.
    oversight: {
      managingCityDepartment: "Example Department",
      managingSystemOfCare: "Example System",
      cityProgramManagerId: "pm1",
    },
    compliance: {},
    perimeter: "",
    updatedAt: "2026-10-20T10:00:00Z",
  };
  return {
    providers: [
      {
        providerId: "v1",
        name: "Example Provider",
        status: "active",
        sites: [{ siteId: "s1", siteName: "Example Site", status: "active" }],
      },
      { providerId: "v2", name: "Second Provider", status: "inactive" },
    ],
    programs: [
      {
        programId: "p1",
        name: "Example Program",
        providerId: "v1",
        status: "active",
      },
      {
        programId: "p2",
        name: "Closed Program",
        providerId: "v2",
        status: "inactive",
      },
    ],
    /** @type {Record<string, any>[]} */
    sites: [
      site,
      {
        siteId: "s2",
        name: "Quiet Site",
        providerId: "v2",
        leadProgramId: "p2",
        status: "inactive",
        updatedAt: "2026-10-01T10:00:00Z",
      },
    ],
    /** Extra items returned with a Site record, keyed by Site ID. */
    /** @type {Record<string, any[]>} */
    siteItems: {
      s1: [
        {
          sk: "ASSIGNED_USER#u1",
          type: "siteUserAssignment",
          userId: "u1",
          status: "active",
        },
      ],
    },
    people: [
      {
        personId: "u1",
        firstName: "Alex",
        lastName: "Example",
        email: "alex@example.org",
        phone: "4155550101",
        status: "active",
      },
      {
        personId: "u2",
        firstName: "Blair",
        lastName: "Sample",
        email: "blair@example.org",
        status: "active",
      },
    ],
    /** Program staff keyed by Program ID; a Program's first staff has no person record. */
    /** @type {Record<string, Record<string, any>[]>} */
    programUsers: {
      p1: [
        {
          userId: "u1",
          programId: "p1",
          firstName: "Alex",
          lastName: "Example",
          email: "alex@example.org",
          status: "active",
          siteManager: true,
        },
      ],
    },
    programManagers: [
      {
        userId: "pm1",
        firstName: "Casey",
        lastName: "Manager",
        email: "casey@example.org",
        status: "active",
      },
    ],
    adminUsers: [
      {
        username: "admin1",
        firstName: "Dana",
        lastName: "Admin",
        email: "dana@example.org",
        role: "compliance-supervisor",
        status: "active",
      },
      {
        username: "admin2",
        firstName: "Eli",
        lastName: "Pending",
        email: "eli@example.org",
        role: "compliance-manager",
        status: "invited",
      },
    ],
    // admin-oversight.js publicOption: departments carry departmentId, systems only a name.
    departments: [{ departmentId: "d1", name: "Example Department" }],
    systemsOfCare: [{ name: "Example System" }],
    /** Each period carries its siteId. */
    terms: [
      {
        siteId: "s1",
        effectiveStart: "2026-10-01",
        reasons: ["1"],
        requiredChecksPerDay: 2,
        createdAt: "2026-10-01T10:00:00Z",
      },
    ],
    /** @type {Record<string, any>[]} */
    memberships: [],
    /** Each grant carries its siteId. @type {Record<string, any>[]} */
    grants: [],
    /** Each device carries its siteId. @type {Record<string, any>[]} */
    devices: [],
    imports: [],
    /** Stored rows of each Site import, keyed by import ID. */
    /** @type {Record<string, Record<string, any>[]>} */
    importRows: {},
    /** Each manager, enrollment and grant carries its providerId. @type {Record<string, any>[]} */
    providerManagers: [],
    /** @type {Record<string, any>[]} */
    providerEnrollments: [],
    /** @type {Record<string, any>[]} */
    providerGrants: [],
    profile: {
      directoryUserId: "pm1",
      firstName: "Casey",
      lastName: "Manager",
      email: "casey@example.org",
    },
  };
}

/** @typedef {ReturnType<typeof adminData>} AdminData */

/**
 * Serve the admin API from `data`, in the reply shapes services/admin-api.js reads.
 * @param {AdminData} data
 * @param {string} role
 * @param {AdminRequest} request
 * @returns {AdminReply}
 */
function defaultReply(data, role, request) {
  const { method, path: p, search } = request;
  const exec = pathMatcher(p);
  if (!exec) return badPath;
  const supervisor = role === "compliance-supervisor";
  const siteRecord = (/** @type {string} */ siteId) => {
    const site = data.sites.find((item) => item.siteId === siteId);
    return site
      ? [{ ...site, sk: "#META" }, ...(data.siteItems[siteId] || [])]
      : [];
  };
  if (!supervisor && supervisorRoutes.some((re) => re.test(`${method} ${p}`)))
    return supervisorRequired;
  if (method !== "GET") return writeReply(data, request, exec);
  if (p === "session")
    return {
      json: {
        role,
        capabilities: {
          manageAdminUsers: supervisor,
          createEntities: supervisor,
          manageProviderManagers: supervisor,
        },
      },
    };
  if (p === "profile") return { json: { profile: data.profile } };
  if (p === "providers") {
    // admin.js listProviders: active providers only, with Sites only for the directory.
    const inactive = new Set(
      data.providers
        .filter((item) => item.status !== "active")
        .map((item) => item.providerId),
    );
    return {
      json: {
        providers: data.providers.filter((item) => item.status === "active"),
        ...(/[?&]directory=1(&|$)/.test(search)
          ? {
              // Sites are read through active providers; fixtures without one stay listed.
              sites: data.sites
                .filter((site) => !inactive.has(site.providerId))
                // admin.js drops compliance and letters from directory summaries.
                .map((site) => ({
                  items: siteRecord(site.siteId).map((item) => {
                    if (item.sk !== "#META") return item;
                    const summary = { ...item };
                    delete summary.compliance;
                    delete summary.complianceLetters;
                    return summary;
                  }),
                })),
            }
          : {}),
      },
    };
  }
  if (p === "programs") return { json: { programs: data.programs } };
  if (p === "oversight-options")
    return {
      json: {
        departments: data.departments,
        systemsOfCare: data.systemsOfCare,
      },
    };
  if (p === "program-managers")
    return { json: { programManagers: data.programManagers } };
  if (p === "admin-users")
    return { json: { users: data.adminUsers, directoryMode: "cognito" } };
  if (p === "people") return { json: { people: data.people } };
  if (p === "site-imports") return { json: { imports: data.imports } };
  // admin-site-imports.js getSiteImport: { import, rows }.
  let m = exec(/^site-imports\/([^/]+)$/, p);
  if (m) {
    const importId = m[1];
    const record = /** @type {Record<string, any>[]} */ (data.imports).find(
      (item) => item.importId === importId,
    );
    if (!record) return { status: 404, json: { error: "import_not_found" } };
    return { json: { import: record, rows: data.importRows[importId] || [] } };
  }
  m = exec(/^sites\/([^/]+)$/, p);
  if (m) {
    const items = siteRecord(m[1]);
    if (!items.length) return notFound;
    // admin.js getSite: authorizeSiteChanges lets a Compliance manager edit
    // only Sites they're actively assigned to; the status view never edits.
    const assigned = items.some(
      (item) =>
        item.sk === `COMPLIANCE_MANAGER#${data.profile.directoryUserId}` &&
        item.status === "active",
    );
    return {
      json: {
        items,
        permissions: {
          canEdit:
            !/[?&]view=status(&|$)/.test(search) && (supervisor || assigned),
        },
      },
    };
  }
  m = exec(/^sites\/([^/]+)\/(terms|manager-memberships|grants|devices)$/, p);
  if (m) {
    const siteId = m[1];
    // Keyed by Site, so a page showing another Site's records fails a test.
    const onSite = (/** @type {any} */ item) => item.siteId === siteId;
    return {
      json: {
        terms: { terms: data.terms.filter(onSite) },
        "manager-memberships": { memberships: siteMemberships(data, siteId) },
        grants: { grants: data.grants.filter(onSite) },
        devices: { devices: data.devices.filter(onSite) },
      }[m[2]],
    };
  }
  m = exec(/^providers\/([^/]+)$/, p);
  if (m) {
    const provider = data.providers.find((item) => item.providerId === m?.[1]);
    if (!provider) return notFound;
    return {
      json: {
        provider,
        sites: data.sites.filter((site) => site.providerId === m?.[1]),
        programs: data.programs.filter((item) => item.providerId === m?.[1]),
      },
    };
  }
  m = exec(/^providers\/([^/]+)\/(manager-memberships|grants)$/, p);
  if (m) {
    // Keyed by provider, so a page showing another provider's records fails a test.
    const providerId = m[1];
    const ofProvider = (/** @type {any} */ item) =>
      item.providerId === providerId;
    return {
      json:
        m[2] === "grants"
          ? { grants: data.providerGrants.filter(ofProvider) }
          : {
              managers: data.providerManagers.filter(ofProvider),
              enrollments: data.providerEnrollments.filter(ofProvider),
            },
    };
  }
  m = exec(/^programs\/([^/]+)$/, p);
  if (m) {
    const id = m[1];
    const program = data.programs.find((item) => item.programId === id);
    if (!program) return notFound;
    return {
      json: {
        program,
        users: data.programUsers[id] || [],
        sites: data.sites.filter((site) => site.leadProgramId === id),
      },
    };
  }
  return noRoute;
}

/**
 * Routes whose backend handler is wrapped in supervisorOnly (lambda/api.js
 * names each handler), so a Compliance manager gets the backend's 403.
 */
const supervisorRoutes = [
  // admin.js
  /^POST providers$/,
  /^DELETE providers\/[^/]+$/,
  /^POST program-managers$/,
  /^PATCH program-managers\/[^/]+$/,
  /^POST providers\/[^/]+\/sites$/,
  /^POST sites\/[^/]+\/reassign$/,
  /^DELETE sites\/[^/]+$/,
  // admin-oversight.js
  /^POST oversight-options$/,
  // admin-programs.js
  /^POST programs$/,
  /^POST providers\/[^/]+\/programs$/,
  /^DELETE programs\/[^/]+$/,
  /^DELETE programs\/[^/]+\/users\/[^/]+$/,
  // admin-site-config.js
  /^PUT sites\/[^/]+\/(compliance-managers|deliberate-311)$/,
  // admin-provider-managers.js: every route.
  /^[A-Z]+ providers\/[^/]+\/(manager-memberships|manager-grants|grants|manager-enrollments)(\/|$)/,
  // admin-users.js: every admin-users route.
  /^[A-Z]+ admin-users(\/|$)/,
  // admin-site-imports.js: every route.
  /^[A-Z]+ site-imports(\/|$)/,
];

/** @param {string} value */
const slug = (value) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** admin.js cleanText: non-strings count as blank. @param {unknown} value */
const cleanText = (value) =>
  typeof value === "string" ? value.trim().slice(0, 250) : "";

/** @param {string} error */
const badRequest = (error) => ({ status: 400, json: { error } });

/** admin.js normalizeSiteType's list. */
const siteTypes = [
  "permanent_supportive_housing",
  "shelter",
  "drop_in",
  "other",
];

/** admin.js drops a leading US 1 before counting digits. @param {unknown} value */
const nationalPhone = (value) => {
  const digits = cleanText(value).replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1")
    ? digits.slice(1)
    : digits;
};

/** admin.js normalizeAddressParts. @param {unknown} value */
function normalizeAddressParts(value) {
  if (!value || typeof value !== "object") return null;
  const input = /** @type {Record<string, unknown>} */ (value);
  const parts = {
    streetNumber: cleanText(input.streetNumber),
    streetAddress: cleanText(input.streetAddress),
    secondLine: cleanText(input.secondLine),
    city: cleanText(input.city),
    state: cleanText(input.state).toUpperCase(),
    zip: cleanText(input.zip),
  };
  if (
    !parts.streetNumber ||
    !parts.streetAddress ||
    !parts.city ||
    !/^[A-Z]{2}$/.test(parts.state) ||
    !/^\d{5}(?:-\d{4})?$/.test(parts.zip)
  )
    return null;
  return parts;
}

/** admin.js normalizePublicContact. @param {unknown} value */
function normalizePublicContact(value) {
  if (!value || typeof value !== "object") return null;
  const input = /** @type {Record<string, unknown>} */ (value);
  const email = cleanText(input.email).toLowerCase();
  const phone = nationalPhone(input.phone);
  if (
    (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) ||
    (cleanText(input.phone) && phone.length !== 10)
  )
    return null;
  return {
    email,
    phoneExtension: cleanText(input.phoneExtension).slice(0, 20),
    phone: phone
      ? `${phone.slice(0, 3)}-${phone.slice(3, 6)}-${phone.slice(6)}`
      : "",
  };
}

/** @param {Record<string, string>} parts */
const formatAddress = (parts) =>
  [
    `${parts.streetNumber} ${parts.streetAddress}`,
    parts.secondLine,
    `${parts.city}, ${parts.state} ${parts.zip}`,
  ]
    .filter(Boolean)
    .join(", ");

const notFound = { status: 404, json: { error: "not_found" } };
const supervisorRequired = {
  status: 403,
  json: { error: "supervisor_required" },
};

// One shared object, so the route handler can tell a missing route from a scripted 404.
const noRoute = { status: 404, json: { error: "no_mock_route" } };
// Shared for the same reason: a path that won't decode is a mock failure.
const badPath = { status: 400, json: { error: "malformed_path" } };

/**
 * @typedef {(pattern: RegExp, value: string) => RegExpExecArray | null} PathMatcher
 */

/**
 * One list for GET, POST and DELETE, so a removal can't reach another Site's
 * membership, which the backend answers with manager_membership_not_found.
 * @param {AdminData} data
 * @param {string} siteId
 */
const siteMemberships = (data, siteId) => [
  // Seeded memberships without a siteId belong to s1; POSTed ones live in siteItems.
  ...data.memberships.filter((item) => (item.siteId || "s1") === siteId),
  ...(data.siteItems[siteId] || []).filter(
    (item) => item.type === "managerMembership",
  ),
];

/**
 * Decode each path segment once, as API Gateway decodes path parameters, so
 * every route sees the same IDs. Returns null when a segment won't decode.
 * @param {string} p
 * @returns {PathMatcher | null}
 */
function pathMatcher(p) {
  /** @type {Map<string, string>} */
  const decoded = new Map();
  try {
    for (const segment of p.split("/"))
      decoded.set(segment, decodeURIComponent(segment));
  } catch {
    return null;
  }
  return (pattern, value) => {
    const match = pattern.exec(value);
    // Whole-segment captures get decoded; others, like (\/reinstate)?, stay raw.
    if (match)
      for (let index = 1; index < match.length; index++)
        match[index] = decoded.get(match[index]) ?? match[index];
    return match;
  };
}

/**
 * Apply a write to `data` and answer with the backend handler's reply shape.
 * @param {AdminData} data
 * @param {AdminRequest} request
 * @param {PathMatcher} exec
 * @returns {AdminReply}
 */
function writeReply(data, request, exec) {
  const { method, path: p } = request;
  const body =
    request.body && typeof request.body === "object" ? request.body : {};
  const now = new Date().toISOString();
  const route = `${method} ${p}`;
  /** @type {RegExpExecArray | null} */
  let m;
  // admin.js createProvider: 201 { provider }.
  if (route === "POST providers") {
    const provider = {
      providerId: slug(body.providerId || body.name || ""),
      name: String(body.name || "").trim(),
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    data.providers.push(provider);
    return { status: 201, json: { provider } };
  }
  // admin.js updateProvider: { provider }.
  if ((m = exec(/^PATCH providers\/([^/]+)$/, route))) {
    const provider = data.providers.find((item) => item.providerId === m?.[1]);
    if (!provider) return notFound;
    provider.name = String(body.name || "").trim();
    return { json: { provider: { ...provider, updatedAt: now } } };
  }
  // admin.js createSite: 201 { site }, checked in the handler's order.
  if ((m = exec(/^POST providers\/([^/]+)\/sites$/, route))) {
    const name = String(body.name ?? "").trim();
    if (!name) return badRequest("name_required");
    const address =
      typeof body.address === "string"
        ? body.address.trim().replace(/\s+/g, " ")
        : "";
    if (address.length < 3 || address.length > 240)
      return badRequest("address_required");
    const provider = data.providers.find((item) => item.providerId === m?.[1]);
    if (!provider || provider.status !== "active")
      return { status: 404, json: { error: "provider_not_found" } };
    const leadProgramId = cleanText(body.leadProgramId);
    const contactId = cleanText(body.primaryContactUserId);
    const addressParts =
      body.addressParts === undefined
        ? null
        : normalizeAddressParts(body.addressParts);
    if (body.addressParts !== undefined && !addressParts)
      return badRequest("invalid_address");
    const publicContact =
      body.publicContact === undefined
        ? null
        : normalizePublicContact(body.publicContact);
    if (body.publicContact !== undefined && !publicContact)
      return badRequest("invalid_public_contact");
    const siteType = siteTypes.includes(cleanText(body.siteType))
      ? cleanText(body.siteType)
      : "";
    if (body.siteType !== undefined && body.siteType !== "" && !siteType)
      return badRequest("invalid_site_type");
    const program = leadProgramId
      ? data.programs.find((item) => item.programId === leadProgramId)
      : undefined;
    if (leadProgramId && (!program || program.status === "inactive"))
      return badRequest("incompatible_program");
    const contact = contactId
      ? (data.programUsers[leadProgramId] || []).find(
          (user) => user.userId === contactId,
        )
      : undefined;
    if (contactId && !leadProgramId) return badRequest("site_program_required");
    if (contactId && contact?.status !== "active")
      return badRequest("invalid_internal_site_contact");
    const siteId = slug(body.siteId || `${provider.providerId}-${name}`);
    // The backend's conditional put fails on an existing Site, so nothing is written.
    if (data.sites.some((item) => item.siteId === siteId))
      return { status: 409, json: { error: "site_already_exists" } };
    const site = {
      siteId,
      name,
      address,
      location: { latitude: 37.77, longitude: -122.41 },
      ...(addressParts ? { addressParts } : {}),
      ...(publicContact ? { publicContact } : {}),
      ...(siteType ? { siteType } : {}),
      providerId: provider.providerId,
      providerName: provider.name,
      ...(program
        ? { leadProgramId: program.programId, programName: program.name }
        : {}),
      ...(contact
        ? {
            primaryContactUserId: contact.userId,
            primaryContact: {
              firstName: contact.firstName,
              lastName: contact.lastName,
              phone: contact.phone,
              phoneExtension: contact.phoneExtension || "",
              email: contact.email,
            },
          }
        : {}),
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    // admin.js createSite puts the contact on the Site's roster in the same transaction.
    if (contact) {
      (data.siteItems[siteId] ||= []).push({
        sk: `ASSIGNED_USER#${contact.userId}`,
        type: "siteUserAssignment",
        siteId,
        programId: leadProgramId,
        userId: contact.userId,
        firstName: contact.firstName,
        lastName: contact.lastName,
        phone: contact.phone,
        phoneExtension: contact.phoneExtension || "",
        email: contact.email,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      contact.siteAssignmentCount =
        Number(contact.siteAssignmentCount || 0) + 1;
    }
    data.sites.push(site);
    return { status: 201, json: { site } };
  }
  // admin.js updateSite: { site } with the stored fields merged.
  if ((m = exec(/^PATCH sites\/([^/]+)$/, route))) {
    const site = data.sites.find((item) => item.siteId === m?.[1]);
    if (!site) return notFound;
    const kept = [
      "name",
      "addressParts",
      "contactPerson",
      "publicContact",
      "oversight",
      "compliance",
      "siteType",
      "perimeter",
    ];
    for (const key of kept) if (body[key] !== undefined) site[key] = body[key];
    if (body.addressParts) site.address = formatAddress(body.addressParts);
    else if (body.address !== undefined) site.address = body.address;
    // admin.js updateSite geocodes a changed address, so the reply carries a new location.
    if (body.addressParts || body.address !== undefined) {
      site.location = { latitude: 37.75, longitude: -122.41 };
      site.geocodedAddress = site.address;
    }
    site.updatedAt = now;
    return { json: { site: { ...site } } };
  }
  // admin-site-config.js putSiteDeliberate311: { site }, 409 when the version moved.
  if ((m = exec(/^PUT sites\/([^/]+)\/deliberate-311$/, route))) {
    const site = data.sites.find((item) => item.siteId === m?.[1]);
    if (!site || site.status === "inactive") return notFound;
    if (typeof body.deliberate311ProductionEnabled !== "boolean")
      return { status: 400, json: { error: "boolean_required" } };
    if (body.expectedUpdatedAt !== (site.updatedAt || ""))
      return { status: 409, json: { error: "site_changed" } };
    site.deliberate311ProductionEnabled = body.deliberate311ProductionEnabled;
    site.updatedAt = now;
    return { json: { site: { ...site } } };
  }
  // admin-programs.js createProgram: 201 { program, user? }; the first staff has no personId.
  if (route === "POST programs") {
    const provider = data.providers.find(
      (item) => item.providerId === body.providerId,
    );
    if (!provider || provider.status !== "active")
      return { status: 404, json: { error: "provider_not_found" } };
    const programId = slug(body.programId || `${body.providerId}-${body.name}`);
    const source = body.existingStaff || {};
    const sourceRecord = source.providerManagerId
      ? /** @type {Record<string, any>[]} */ (data.providerManagers).find(
          (item) => item.membershipId === source.providerManagerId,
        )
      : (data.programUsers[source.programId] || []).find(
          (item) => item.userId === source.userId,
        );
    // The backend copies the source's contact, so later edits to it don't reach this Program.
    const staff =
      body.firstStaff ??
      (sourceRecord && {
        firstName: sourceRecord.firstName,
        lastName: sourceRecord.lastName,
        email: sourceRecord.email,
        phone: sourceRecord.phone || "",
        phoneExtension: sourceRecord.phoneExtension || "",
      });
    const userId = staff ? `${programId}-staff` : null;
    const program = {
      ...(userId && body.contact === undefined
        ? { primaryContactUserId: userId }
        : {}),
      programId,
      name: String(body.name || "").trim(),
      providerId: provider.providerId,
      providerName: provider.name,
      contact: body.contact ?? staff ?? {},
      status: "active",
      migrationPlaceholder: body.migrationPlaceholder === true,
      needsReview: body.needsReview === true,
      createdAt: now,
      updatedAt: now,
    };
    const user = staff
      ? {
          programId,
          userId,
          ...staff,
          siteManager: false,
          status: "active",
          siteAssignmentCount: 0,
          createdAt: now,
          updatedAt: now,
        }
      : null;
    data.programs.push(program);
    data.programUsers[programId] = user ? [user] : [];
    return { status: 201, json: { program, ...(user ? { user } : {}) } };
  }
  // admin-programs.js createProgramUser: 201 { user }, linked to a new person.
  if ((m = exec(/^POST programs\/([^/]+)\/users$/, route))) {
    const programId = m[1];
    if (!data.programs.some((item) => item.programId === programId))
      return { status: 404, json: { error: "program_not_found" } };
    const users = (data.programUsers[programId] ||= []);
    const userId = `${programId}-u${users.length + 1}`;
    const user = {
      programId,
      userId,
      personId: userId,
      ...body,
      siteManager: body.siteManager === true,
      status: "active",
      siteAssignmentCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    users.push(user);
    data.people.push({
      personId: userId,
      firstName: body.firstName,
      lastName: body.lastName,
      email: body.email,
      ...(body.phone ? { phone: body.phone } : {}),
      status: "active",
    });
    return { status: 201, json: { user } };
  }
  // admin-programs.js updateProgram: { program }, 409 when the version moved.
  if ((m = exec(/^PATCH programs\/([^/]+)$/, route))) {
    const name = String(body.name || "").trim();
    if (!name) return { status: 400, json: { error: "name_required" } };
    const program = /** @type {Record<string, any> | undefined} */ (
      data.programs.find((item) => item.programId === m?.[1])
    );
    if (!program || program.status === "inactive") return notFound;
    if (
      body.expectedUpdatedAt !== undefined &&
      body.expectedUpdatedAt !== (program.updatedAt || "")
    )
      return { status: 409, json: { error: "program_update_conflict" } };
    Object.assign(program, { name, updatedAt: now });
    return { json: { program: { ...program } } };
  }
  // admin-programs.js updateProgramUser: { user }.
  if ((m = exec(/^PATCH programs\/([^/]+)\/users\/([^/]+)$/, route))) {
    const user = (data.programUsers[m[1]] || []).find(
      (item) => item.userId === m?.[2],
    );
    if (!user) return notFound;
    const contact = {
      firstName: String(body.firstName || "").trim(),
      lastName: String(body.lastName || "").trim(),
      phone: String(body.phone || "").trim(),
      phoneExtension: String(body.phoneExtension || "").trim(),
      email: String(body.email || "")
        .trim()
        .toLowerCase(),
    };
    const previousEmail = String(user.email || "").toLowerCase();
    // admin-programs.js updateProgramUser saves only these fields, and skips
    // siteManager for a person-linked staff edit that leaves the contact alone.
    Object.assign(user, contact, { updatedAt: now });
    if (!user.personId || body.isPrimaryContact !== undefined)
      user.siteManager = body.siteManager === true;
    // The Program's primary contact moves only when the edit names it.
    const program = /** @type {Record<string, any> | undefined} */ (
      data.programs.find((item) => item.programId === m?.[1])
    );
    if (program && body.isPrimaryContact !== undefined) {
      const wasPrimary = program.primaryContactUserId
        ? program.primaryContactUserId === user.userId
        : Boolean(
            program.contact?.email &&
              program.contact.email.toLowerCase() === previousEmail,
          );
      if (body.isPrimaryContact) {
        program.primaryContactUserId = user.userId;
        program.contact = contact;
      } else if (wasPrimary) {
        delete program.primaryContactUserId;
        program.contact = {};
      }
    }
    return { json: { user: { ...user } } };
  }
  // admin-people.js createPerson: 201 { person }.
  if (route === "POST people") {
    const person = {
      personId: `person-${data.people.length + 1}`,
      ...body,
      name: `${body.firstName || ""} ${body.lastName || ""}`.trim(),
      siteManager: true,
      sources: [],
      status: "active",
      createdAt: now,
    };
    data.people.push(person);
    return { status: 201, json: { person } };
  }
  // admin-people.js updatePerson: { person }.
  if ((m = exec(/^PATCH people\/([^/]+)$/, route))) {
    const person = data.people.find((item) => item.personId === m?.[1]);
    if (!person || person.status !== "active")
      return { status: 404, json: { error: "person_not_found" } };
    Object.assign(person, body);
    return { json: { person: { ...person } } };
  }
  // admin-users.js updateMyProfile: { profile } with the sent fields applied.
  if (route === "PUT profile") {
    Object.assign(data.profile, body);
    return { json: { profile: { ...data.profile } } };
  }
  // admin-manager-memberships.js createManagerMembership: 201 { membership },
  // checked in the handler's order.
  if ((m = exec(/^POST sites\/([^/]+)\/manager-memberships$/, route))) {
    const siteId = m[1];
    const text = (/** @type {unknown} */ value) => String(value ?? "").trim();
    const programId = text(body.programId);
    const userId = text(body.userId);
    let personId = text(body.personId);
    if (personId && (body.userId || body.programId))
      return badRequest("invalid_program_staff");
    /** @param {string} id */
    const findPerson = (id) =>
      /** @type {Record<string, any>[]} */ (data.people).find(
        (item) => item.personId === id,
      );
    let person = personId ? findPerson(personId) : undefined;
    if (personId && person?.status !== "active")
      return { status: 404, json: { error: "person_not_found" } };
    /** @param {Record<string, any>} record */
    const personName = (record) =>
      record.name ||
      `${record.firstName || ""} ${record.lastName || ""}`.trim();
    let name = person ? personName(person) : text(body.name);
    let email = person
      ? String(person.email || "")
      : text(body.email).toLowerCase();
    if (!name || name.length > 200) return badRequest("invalid_manager_name");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320)
      return badRequest("invalid_manager_email");
    const site = data.sites.find((item) => item.siteId === siteId);
    if (!site || site.status === "inactive")
      return { status: 404, json: { error: "site_not_found" } };
    if (Boolean(userId) !== Boolean(programId))
      return badRequest("invalid_program_staff");
    const items = (data.siteItems[siteId] ||= []);
    /** @type {Record<string, any> | undefined} */
    let staffRecord;
    if (userId) {
      const staff = (data.programUsers[programId] || []).find(
        (item) => item.userId === userId,
      );
      if (staff?.status !== "active")
        return { status: 404, json: { error: "program_user_not_found" } };
      // site-manager-assignment.js adds no roster row for staff already on the Site,
      // so the membership keeps the typed name and email and gets no person.
      const assigned = items.some(
        (item) =>
          item.sk === `ASSIGNED_USER#${userId}` && item.status === "active",
      );
      if (!assigned) {
        staffRecord = staff;
        // Staff linked to a person take that person's name and email, as the backend does.
        const linked = !person && staff.personId && findPerson(staff.personId);
        if (linked) {
          person = linked;
          personId = staff.personId;
          name = personName(linked);
          email = String(linked.email || "");
        }
      }
    }
    // The backend's conditional puts on MANAGER_USER, MANAGER_PERSON and
    // MANAGER_EMAIL fail when an active membership already holds one.
    const taken = siteMemberships(data, siteId).some(
      (item) =>
        item.status === "active" &&
        ((userId && item.userId === userId) ||
          (person && item.personId === personId) ||
          String(item.email || "").toLowerCase() === email.toLowerCase()),
    );
    if (taken)
      return { status: 409, json: { error: "manager_membership_exists" } };
    if (staffRecord) {
      items.push({
        sk: `ASSIGNED_USER#${userId}`,
        type: "siteUserAssignment",
        siteId,
        programId,
        userId,
        ...(staffRecord.personId ? { personId: staffRecord.personId } : {}),
        firstName: staffRecord.firstName,
        lastName: staffRecord.lastName,
        email: staffRecord.email,
        phone: staffRecord.phone,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      staffRecord.siteAssignmentCount =
        Number(staffRecord.siteAssignmentCount || 0) + 1;
    }
    const membershipId = `${siteId}-m${items.length + 1}`;
    const membership = {
      sk: `MANAGER_MEMBERSHIP#${membershipId}`,
      type: "managerMembership",
      membershipId,
      siteId,
      ...(programId ? { programId } : {}),
      ...(userId ? { userId } : {}),
      ...(person
        ? {
            personId,
            firstName: person.firstName,
            lastName: person.lastName,
            phone: person.phone,
            phoneExtension: person.phoneExtension,
          }
        : {}),
      name,
      email,
      role: "manager",
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    items.push(membership);
    return { status: 201, json: { membership } };
  }
  // admin-manager-memberships.js deactivateManagerMembership.
  if (
    (m = exec(/^DELETE sites\/([^/]+)\/manager-memberships\/([^/]+)$/, route))
  ) {
    const membership = siteMemberships(data, m[1]).find(
      (item) => item.membershipId === m?.[2] && item.status === "active",
    );
    if (!membership)
      return { status: 404, json: { error: "manager_membership_not_found" } };
    Object.assign(membership, { status: "inactive", updatedAt: now });
    return {
      json: {
        deactivated: true,
        membershipId: membership.membershipId,
        revokedBindingCount: 0,
      },
    };
  }
  // admin-site-config.js unassignSiteUser: { unassigned, userId, revokedBindingCount }.
  if ((m = exec(/^DELETE sites\/([^/]+)\/users\/([^/]+)$/, route))) {
    const userId = m[2];
    const assignment = (data.siteItems[m[1]] || []).find(
      (item) =>
        item.sk === `ASSIGNED_USER#${userId}` && item.status === "active",
    );
    if (!assignment) return notFound;
    assignment.status = "inactive";
    return { json: { unassigned: true, userId, revokedBindingCount: 0 } };
  }
  // admin.js revokeDevice: { device }.
  if ((m = exec(/^DELETE sites\/([^/]+)\/devices\/([^/]+)$/, route))) {
    const device = /** @type {Record<string, any>[]} */ (data.devices).find(
      (item) =>
        item.siteId === m?.[1] && (item.bindingId || item.deviceId) === m?.[2],
    );
    if (!device) return notFound;
    device.status = "revoked";
    return { json: { device: { ...device } } };
  }
  // admin-provider-managers.js revokeProviderManagerEnrollment.
  if (
    (m = exec(
      /^POST providers\/([^/]+)\/manager-enrollments\/([^/]+)\/revoke$/,
      route,
    ))
  ) {
    const enrollment = /** @type {Record<string, any>[]} */ (
      data.providerEnrollments
    ).find((item) => item.enrollmentId === m?.[2]);
    if (!enrollment || enrollment.status !== "active")
      return {
        status: 404,
        json: { error: "provider_manager_enrollment_not_found" },
      };
    enrollment.status = "revoked";
    return {
      json: {
        revoked: true,
        enrollmentId: enrollment.enrollmentId,
        revokedBindingCount: (enrollment.siteBindings || []).length,
      },
    };
  }
  // admin-users.js lookupAdminInvitation: { profile }, null with no saved contact.
  if (route === "POST admin-users/lookup") {
    const email = cleanText(body.email).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return badRequest("valid_email_required");
    return { json: { profile: null } };
  }
  return noRoute;
}

/**
 * Mock the admin API for one page.
 * @param {import("@playwright/test").Page} page
 * @param {{ role?: "compliance-supervisor" | "compliance-manager", data?: AdminData }} [options]
 */
export async function mockAdmin(page, options = {}) {
  const api = fakeAdminApi(options, () => settle(page));
  mockFailuresByPage.set(page, api.failures);
  await page.addInitScript(() => {
    /** @type {any} */ (window).GOOD_NEIGHBOR_ADMIN_CONFIG = {
      apiBase: window.location.origin,
      localDebugAdmin: true,
    };
  });
  await page.route(/\/config\.js$/, (route) =>
    new URL(route.request().url()).pathname === "/config.js"
      ? route.fulfill({ contentType: "application/javascript", body: "" })
      : route.fallback(),
  );
  await page.route("**/admin/v1/**", async (route) => {
    const url = new URL(route.request().url());
    // settle()'s probe request; not logged, so api.calls() counts only the admin pages' requests.
    if (url.pathname === fencePath) return route.fulfill({ status: 204 });
    const reply = await api.handle(
      route.request().method(),
      url,
      route.request().postData(),
      route.request().headers(),
    );
    if (reply.body !== undefined)
      return route
        .fulfill({
          status: reply.status || 200,
          contentType: reply.contentType || "text/plain",
          headers: reply.headers,
          body: reply.body,
        })
        .catch(() => {});
    await route
      .fulfill({
        status: reply.status || 200,
        headers: reply.headers,
        json: reply.json ?? {},
      })
      .catch(() => {});
  });
  return api;
}

/**
 * The fake /admin/v1 backend with no browser, so unit tests call it directly.
 * @param {{ role?: "compliance-supervisor" | "compliance-manager", data?: AdminData }} options
 * @param {() => Promise<void>} settleRequests waits until every request the mounted page started has arrived
 */
export function fakeAdminApi(options, settleRequests) {
  const role = options.role || "compliance-supervisor";
  const data = options.data || adminData();
  /** @type {AdminRequest[]} */
  const requests = [];
  /** @type {string[]} */
  const failures = [];
  /** @type {{ method: string, pattern: RegExp, handler: AdminHandler }[]} */
  const handlers = [];
  const api = {
    data,
    requests,
    failures,
    /**
     * Answer matching requests first; the newest handler wins. A handler that
     * returns undefined falls through to older handlers and the defaults.
     * @param {string} method
     * @param {RegExp} pattern matched against the path after /admin/v1/, plus its query
     * @param {AdminHandler | AdminReply} handler
     */
    on(method, pattern, handler) {
      handlers.unshift({
        method,
        pattern,
        handler: typeof handler === "function" ? handler : () => handler,
      });
      return api;
    },
    /**
     * Fail matching requests with an API error.
     * @param {string} method
     * @param {RegExp} pattern
     * @param {number} [status]
     * @param {string} [message]
     */
    fail(method, pattern, status = 500, message = "Synthetic failure") {
      return api.on(method, pattern, {
        status,
        json: { error: message, message },
      });
    },
    /**
     * The fake backend's own reply, for a handler that adjusts it.
     * @param {AdminRequest} request
     */
    reply(request) {
      return defaultReply(data, role, request);
    },
    /**
     * Record one /admin/v1 request and answer it, after any scripted delay.
     * @param {string} method
     * @param {URL} url
     * @param {string | null} raw request body
     * @param {Record<string, string>} headers
     * @returns {Promise<AdminReply>}
     */
    async handle(method, url, raw, headers) {
      /** @type {AdminRequest} */
      const request = {
        method,
        path: url.pathname.replace(/^\/admin\/v1\//, ""),
        search: url.search,
        body: raw ? safeJson(raw) : undefined,
        headers,
      };
      requests.push(request);
      /** @type {AdminReply | undefined} */
      let reply;
      // A snapshot, since a handler may add handlers and unshift would revisit it.
      for (const { method, pattern, handler } of [...handlers]) {
        if (method !== "*" && method !== request.method) continue;
        const match = pattern.exec(request.path + request.search);
        if (!match) continue;
        try {
          reply = await handler(request, match);
        } catch (error) {
          // Answered so the page doesn't hang, and recorded so teardown fails the test.
          failures.push(
            `${request.method} ${request.path}: handler threw ${String(error)}`,
          );
          reply = {
            status: 500,
            json: { error: "mock_error", message: String(error) },
          };
        }
        if (reply) break;
      }
      reply ||= defaultReply(data, role, request);
      if (reply === noRoute) failures.push(`${request.method} ${request.path}`);
      else if (reply === badPath)
        failures.push(`${request.method} ${request.path}: malformed escape`);
      if (reply.delay) await reply.delay;
      return reply;
    },
    /**
     * @param {string} method
     * @param {RegExp} pattern
     */
    calls(method, pattern) {
      return requests.filter(
        (request) =>
          request.method === method &&
          pattern.test(request.path + request.search),
      );
    },
    /**
     * Fail if the admin page sent a matching request, including one still in flight.
     * @param {string} method
     * @param {RegExp} pattern
     */
    async expectNotSent(method, pattern) {
      await settleRequests();
      expect(api.calls(method, pattern)).toEqual([]);
    },
  };
  return api;
}

/** @param {string} raw */
function safeJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Gates not yet released; see releaseGates(). @type {Set<() => void>} */
const openGates = new Set();

/**
 * A promise a test resolves to release a held response.
 * @returns {{ promise: Promise<void>, release: () => void }}
 */
export function gate() {
  /** @type {() => void} */
  let release = () => {};
  const promise = new Promise((resolve) => {
    release = () => {
      openGates.delete(release);
      resolve(undefined);
    };
  });
  openGates.add(release);
  return { promise, release };
}

/** Release every held gate, so a failed test's held read can't be joined by the next test's. */
export function releaseGates() {
  for (const release of [...openGates]) release();
}

const fencePath = "/admin/v1/__fence";

/**
 * Wait until every request the admin page started has reached the mock. Requests
 * arrive in order, so once a probe sent now is answered, earlier ones are recorded.
 * @param {import("@playwright/test").Page} page
 */
export async function settle(page) {
  await page.evaluate(async (fence) => {
    // Two task turns let the admin page's event handlers run and start their fetch first.
    await new Promise((resolve) =>
      setTimeout(() => setTimeout(() => resolve(undefined), 0), 0),
    );
    await fetch(fence);
  }, fencePath);
}

/**
 * The page-level error line <admin-app> renders from `state.error`.
 * @param {import("@playwright/test").Page} page
 */
export function pageError(page) {
  // startErrorPresentation gives it role="alert"; other alerts sit deeper.
  return page.locator('#main-content > [role="alert"]');
}
