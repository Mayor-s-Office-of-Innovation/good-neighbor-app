import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/** @param {import("@playwright/test").Page} page */
async function setup(page) {
  /** @type {Array<{path: string, body: any}>} */
  const writes = [];
  const member = {
    membershipId: "m",
    status: "active",
    name: "Synthetic Manager",
    email: "synthetic@example.org",
  };
  const site = {
    siteId: "s",
    sk: "#META",
    name: "Synthetic Site",
    status: "active",
    providerId: "p",
  };
  const provider = {
    providerId: "p",
    name: "Synthetic Provider",
    status: "active",
  };
  /** @type {any[]} */
  let grants = [];
  let emailFails = true;
  await page.addInitScript(() => {
    /** @type {any} */ (window).GOOD_NEIGHBOR_ADMIN_CONFIG = {
      apiBase: location.origin,
      localDebugAdmin: true,
    };
  });
  await page.route("http://127.0.0.1:5176/config.js", (route) =>
    route.fulfill({ body: "", contentType: "application/javascript" }),
  );
  await page.route("**/health", (route) =>
    route.fulfill({ json: { ok: true } }),
  );
  await page.route("**/admin/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const body = method === "GET" ? {} : route.request().postDataJSON();
    if (method !== "GET") writes.push({ path, body });
    /** @type {any} */
    let json = {
      managers: [member],
      memberships: [member],
      grants,
      devices: [],
      users: [],
      enrollments: [],
    };
    if (path.endsWith("/session"))
      json = {
        role: "compliance-supervisor",
        capabilities: { createEntities: true, manageProviderManagers: true },
      };
    else if (path === "/admin/v1/providers")
      json = { providers: [provider], sites: [{ items: [site] }] };
    else if (path === "/admin/v1/providers/p")
      json = { provider, programs: [], sites: [site], managers: [member] };
    else if (path === "/admin/v1/programs") json = { programs: [] };
    else if (path === "/admin/v1/sites/s")
      json = {
        items: [site, { ...member, type: "managerMembership" }],
        permissions: { canEdit: true },
      };
    else if (path.endsWith("/people"))
      json =
        method === "POST"
          ? { person: { ...body, personId: "u" } }
          : { people: [] };
    else if (path.endsWith("/manager-memberships") && method === "POST")
      json = { membership: member };
    else if (path.endsWith("/manager-grants") && method === "POST") {
      const grant = {
        grantId: "g",
        membershipId: "m",
        issuedTo: member.email,
        status: "pending",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        deliveryMode: body.deliveryMode,
        deliveryChannel: body.deliveryChannel || "email",
        deliveryStatus:
          body.deliveryChannel === "screen"
            ? "issued"
            : emailFails
              ? "failed"
              : "accepted",
      };
      emailFails = false;
      grants = [grant];
      json = {
        grant,
        ...(body.deliveryChannel === "screen"
          ? { enrollmentCode: "0AB123" }
          : {}),
      };
    }
    await route.fulfill({ json });
  });
  return writes;
}

for (const scope of ["sites", "providers"]) {
  test(`${scope}: keyboard-issued code disappears on navigation and stays absent on return`, async ({
    page,
  }) => {
    const writes = await setup(page);
    await page.goto(
      `/${scope}/${scope === "sites" ? "s" : "p"}?section=access`,
    );
    const button = page.locator("[data-show-enrollment-code]");
    await button.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-enrollment-code]")).toContainText(
      "0AB123",
    );
    expect(writes.at(-1)?.body).toMatchObject({
      deliveryMode: "code",
      deliveryChannel: "screen",
    });
    expect(
      (
        await new AxeBuilder({ page })
          .include("[data-enrollment-code]")
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.locator('.entity-tabs a[href$="section=details"]').click();
    await expect(page.locator("[data-enrollment-code]")).toHaveCount(0);
    await page.locator('.entity-tabs a[href$="section=access"]').click();
    await expect(page.locator("[data-show-enrollment-code]")).toBeVisible();
    await expect(page.locator("[data-enrollment-code]")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("0AB123");
  });
}

test("create and assign once, then retry only the enrollment email", async ({
  page,
}) => {
  const writes = await setup(page);
  await page.goto("/sites/s?section=details");
  await page.locator("#create-site-manager").click();
  const form = page.locator("#new-site-manager-form");
  for (const [name, value] of [
    ["first-name", "Synthetic"],
    ["last-name", "Manager"],
    ["email", "synthetic@example.org"],
    ["phone", "4155550100"],
  ])
    await form.locator(`[name="new-manager-${name}"] input`).fill(value);
  const check = form.locator('wa-checkbox[name="email-enrollment-link"]');
  await expect(check).not.toHaveAttribute("checked");
  await check.focus();
  await page.keyboard.press("Space");
  await form.locator('button[type="submit"]').click();
  await expect(page.locator("#retry-manager-enrollment")).toBeVisible();
  await page.locator("#retry-manager-enrollment").click();
  await expect(page.locator("#retry-manager-enrollment")).toHaveCount(0);
  expect(writes.filter((w) => w.path.endsWith("/people"))).toHaveLength(1);
  expect(
    writes.filter((w) => w.path.endsWith("/manager-memberships")),
  ).toHaveLength(1);
  expect(writes.filter((w) => w.path.endsWith("/manager-grants"))).toHaveLength(
    2,
  );
});

test("document navigation clears displayed codes before a possible browser cache restore", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/sites/s?section=access");
  await page.locator("[data-show-enrollment-code]").click();
  await expect(page.locator("[data-enrollment-code]")).toBeVisible();
  await page.evaluate(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pagehide", { persisted: true }),
    ),
  );
  await expect(page.locator("[data-enrollment-code]")).toHaveCount(0);
  await page.locator('.entity-tabs a[href$="section=details"]').click();
  await page.locator('.entity-tabs a[href$="section=access"]').click();
  await expect(page.locator("[data-enrollment-code]")).toHaveCount(0);
});
