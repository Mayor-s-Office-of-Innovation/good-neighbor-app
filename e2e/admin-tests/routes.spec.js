import { test, expect, mockAdmin, pageError, settle } from "./admin-mock.js";

const routes = [
  "/sites",
  "/sites?q=Example",
  "/managers",
  "/providers",
  "/programs",
  "/sites/import",
  "/sites/new",
  "/providers/new",
  "/programs/new",
  "/administrators",
  "/administrators/new",
  "/profile",
  "/sites/s1",
  "/sites/s1?section=compliance",
  "/sites/s1?section=oversight",
  "/sites/s1?section=access",
  "/sites/s2",
  "/providers/v1",
  "/programs/p1",
  "/managers/u1",
  "/managers/new",
  "/provider-managers",
];

// Two groups per role keep the per-test page setup low while the groups run in parallel.
const groups = [routes.slice(0, 11), routes.slice(11)];

for (const role of /** @type {const} */ ([
  "compliance-supervisor",
  "compliance-manager",
])) {
  for (const [index, group] of groups.entries()) {
    // A Compliance manager is redirected from Supervisor-only routes, so "loads" not "opens".
    test(`${role} loads route group ${index + 1} without page errors`, async ({
      page,
    }) => {
      const api = await mockAdmin(page, { role });
      for (const route of group)
        await test.step(route, async () => {
          await page.goto(route);
          await expect(page.locator("admin-app h1").first()).toBeVisible();
          // Section reads such as letters start after the h1. Waiting until no new read
          // starts is faster than networkidle, which idles 500 ms per route.
          for (let seen = -1; seen !== api.calls("GET", /./).length; ) {
            seen = api.calls("GET", /./).length;
            await settle(page);
          }
          await expect(pageError(page)).toHaveCount(0);
        });
    });
  }
}
