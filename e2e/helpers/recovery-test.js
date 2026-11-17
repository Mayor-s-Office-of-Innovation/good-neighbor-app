import { test as base, expect } from "@playwright/test";

// This suite has no backend. Page-specific mocks take precedence over this
// context route; falling through must fail the test, even for background fetches.
const apiPath = /^\/(?:(?:app\/)?v1(?:\/|$)|health$|site-code$)/;

export const test = base.extend({
  context: async ({ context }, use) => {
    // Telemetry has its own tests. Use the existing opt-outs here: unload
    // beacons can outlive browser route interception during navigation/close.
    await context.addInitScript(() => {
      window.localStorage.setItem("gnp:errors", "off");
      window.localStorage.setItem("gnp:analytics", "off");
    });
    /** @type {Set<string>} */
    const unexpected = new Set();
    await context.route(
      (url) => apiPath.test(url.pathname),
      async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        // Omit query strings, headers and bodies from failure diagnostics.
        unexpected.add(`${request.method()} ${path}`);
        await route.fulfill({
          status: 501,
          json: { error: "unmocked_recovery_test_request" },
        });
      },
    );
    await use(context);
    // Finish page activity before checking for background requests.
    await context.close();
    expect(
      [...unexpected],
      "Recovery tests must explicitly mock every API request",
    ).toEqual([]);
  },
});

export { expect };
