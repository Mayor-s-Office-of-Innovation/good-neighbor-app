import { test, expect } from "@playwright/test";

const site = {
  sk: "#META",
  siteId: "s",
  name: "Example Site",
  providerId: "p",
  leadProgramId: "g",
  status: "active",
  updatedAt: "2026-10-26T12:00:00Z",
  oversight: {},
};
/** @param {import('@playwright/test').Page} page */
async function setup(page) {
  /** @type {string[]} */
  const requests = [];
  await page.addInitScript(() => {
    /** @type {any} */ (window).GOOD_NEIGHBOR_ADMIN_CONFIG = {
      apiBase: window.location.origin,
      localDebugAdmin: true,
    };
  });
  await page.route("http://127.0.0.1:5176/config.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "" }),
  );
  await page.route("**/admin/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace("/admin/v1/", "");
    requests.push(path + url.search);
    let json = {};
    if (path === "session")
      json = {
        role: "compliance-supervisor",
        capabilities: {
          manageAdminUsers: true,
          createEntities: true,
          manageProviderManagers: true,
        },
      };
    if (path === "providers")
      json = {
        providers: [{ providerId: "p", name: "Provider", status: "active" }],
        ...(url.search ? { sites: [{ items: [site] }] } : {}),
      };
    if (path === "programs")
      json = {
        programs: [{ programId: "g", name: "Program", status: "active" }],
      };
    if (path === "oversight-options")
      json = { departments: [], systemsOfCare: [] };
    if (path === "program-managers") json = { programManagers: [] };
    if (path === "admin-users") json = { users: [] };
    if (path === "people") json = { people: [] };
    if (path === "sites/s")
      json = { items: [site], permissions: { canEdit: true } };
    if (path === "programs/g")
      json = {
        program: { programId: "g", name: "Program" },
        users: [],
        sites: [],
      };
    if (path === "providers/p/sites")
      json = {
        site: {
          ...site,
          addressParts: {},
          publicContact: {},
          primaryContactUserId: "u",
        },
      };
    await route.fulfill({ json });
  });
  return requests;
}
test("Manage users skips unrelated directory reads", async ({ page }) => {
  const requests = await setup(page);
  await page.goto("/administrators");
  await expect(page.locator("#administrators-title")).toBeVisible();
  expect(requests).toEqual(["session", "admin-users"]);
});
test("directory search keeps its input, keyboard focus, and draft while results update", async ({
  page,
}) => {
  const requests = await setup(page);
  await page.goto("/sites");
  const search = page.locator("#directory-search-input");
  await expect(search).toBeVisible();
  await search.evaluate((el) => el.setAttribute("data-original", "yes"));
  await search.locator("input").fill("Example");
  await expect(page).toHaveURL(/q=Example/);
  await expect(search).toHaveAttribute("data-original", "yes");
  await expect(search.locator("input")).toBeFocused();
  await expect(search.locator("input")).toHaveValue("Example");
  expect(requests.filter((path) => path.startsWith("providers/"))).toEqual([]);
  expect(requests.filter((path) => path.startsWith("sites/"))).toEqual([]);
  await page.locator("#clear-directory-search").click();
  await expect(page).not.toHaveURL(/q=/);
  await expect(search).toHaveAttribute("data-original", "yes");
});
test("site sections fetch only needed data and reuse a recent section", async ({
  page,
}) => {
  const requests = await setup(page);
  await page.goto("/sites/s");
  await expect(page.locator(".site-record h1")).toHaveText("Example Site");
  expect(requests.some((path) => /\/devices|\/grants|\/terms/.test(path))).toBe(
    false,
  );
  requests.length = 0;
  await page.locator('a[href="/sites/s?section=oversight"]').click();
  await expect(page.locator("#site-oversight-form")).toBeVisible();
  expect(requests).toEqual(["sites/s?view=oversight"]);
  requests.length = 0;
  await page.locator('a[href="/sites/s?section=details"]').click();
  await expect(page.locator("#site-details-form")).toBeVisible();
  expect(requests).toEqual([]);
});
test("a late record response cannot erase the new administrator draft", async ({
  page,
}) => {
  await setup(page);
  /** @type {(() => void) | undefined} */ let finish;
  await page.route("**/admin/v1/sites/s?view=details", async (route) => {
    await new Promise((resolve) => {
      finish = () => resolve(undefined);
    });
    await route.fulfill({
      json: { items: [site], permissions: { canEdit: true } },
    });
  });
  await page.goto("/sites/s");
  await expect.poll(() => Boolean(finish)).toBe(true);
  await page.evaluate(() => {
    window.history.pushState({}, "", "/administrators/new");
    window.dispatchEvent(new window.PopStateEvent("popstate"));
  });
  const first = page.locator(
    '#admin-user-form wa-input[name="firstName"] input',
  );
  await first.fill("Unsaved draft");
  finish?.();
  await expect(first).toHaveValue("Unsaved draft");
  await expect(page.locator("#admin-user-form")).toBeVisible();
});
test("site creation navigates without rebuilding directories and hides the completed form", async ({
  page,
}) => {
  const requests = await setup(page);
  await page.goto("/sites/new");
  await expect(page.locator("admin-app h1")).toBeVisible();
  requests.length = 0;
  await page.evaluate(async () => {
    const app = /** @type {any} */ (document.querySelector("admin-app"));
    const form = document.createElement("form");
    for (const [name, value] of Object.entries({
      "provider-id": "p",
      "lead-program-id": "g",
      "site-name": "Example Site",
      "site-manager-user-id": "u",
    })) {
      const input = document.createElement("input");
      input.name = name;
      input.value = value;
      form.append(input);
    }
    app.state.newSiteUsers = [];
    await app.createSiteFromFlow(form);
  });
  await expect(page).toHaveURL(/\/sites\/s$/);
  await expect(page.locator(".site-record h1")).toHaveText("Example Site");
  expect(requests.filter((path) => path === "providers?directory=1")).toEqual(
    [],
  );
  expect(requests.filter((path) => path === "providers/p/sites")).toHaveLength(
    1,
  );
  await expect(
    page.locator("#new-site-provider-form, #new-site-record-form"),
  ).toHaveCount(0);
});

test("letter history loads on expansion, paginates, and preserves an unsaved perimeter draft", async ({
  page,
}) => {
  const requests = await setup(page);
  await page.route("**/admin/v1/sites/s?view=letters*", async (route) => {
    const more = new URL(route.request().url()).searchParams.has("cursor");
    const number = more ? 2 : 1;
    await route.fulfill({
      json: {
        items: [
          site,
          {
            type: "complianceLetterEmail",
            sk: `LETTER_EMAIL#${number}`,
            number,
            letter: { url: "/letter.pdf", fileName: `Letter ${number}` },
            recipients: ["staff@example.org"],
            sentAt: "2026-10-26T12:00:00Z",
          },
        ],
        nextCursor: more ? "" : "LETTER_EMAIL#one",
      },
    });
  });
  await page.goto("/sites/s?section=compliance");
  const draft = page.locator("#site-perimeter-form wa-textarea textarea");
  await draft.fill("Unsaved perimeter description");
  expect(requests.some((path) => path.includes("view=letters"))).toBe(false);
  await page.locator("[data-site-letters] summary").click();
  await expect(page.locator("[data-site-letters] table")).toContainText(
    "Letter 1",
  );
  await expect(draft).toHaveValue("Unsaved perimeter description");
  await page.locator("#more-letter-history").click();
  await expect(page.locator("[data-site-letters] table")).toContainText(
    "Letter 2",
  );
  await expect(page.locator("[data-site-letters] tbody tr")).toHaveCount(2);
  await expect(draft).toHaveValue("Unsaved perimeter description");
  await expect(page.locator("#more-letter-history")).toHaveCount(0);
});

test("a failed page read can be retried without replaying a mutation", async ({
  page,
}) => {
  await setup(page);
  let reads = 0;
  await page.route("**/admin/v1/admin-users", (route) =>
    route.fulfill(
      ++reads === 1
        ? { status: 503, json: { error: "temporarily_unavailable" } }
        : { json: { users: [] } },
    ),
  );
  await page.goto("/administrators");
  await page.locator("#retry-page-load").click();
  await expect(page.locator("#retry-page-load")).toHaveCount(0);
  await expect(page.locator("#administrators-title")).toBeVisible();
  await expect(page.locator("main > .error")).toHaveCount(0);
  expect(reads).toBe(2);
});
