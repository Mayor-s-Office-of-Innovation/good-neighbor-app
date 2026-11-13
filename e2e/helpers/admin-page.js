// Shared by the admin specs that mock /admin/v1 and the Insights specs that run it on emulators.

/**
 * The checked-in config.js would overwrite the settings an init script gave the page.
 * @param {import("@playwright/test").Page} page
 */
export function blankConfigJs(page) {
  return page.route(/\/config\.js$/, (route) =>
    new URL(route.request().url()).pathname === "/config.js"
      ? route.fulfill({ contentType: "application/javascript", body: "" })
      : route.fallback(),
  );
}

/**
 * A render that throws can leave the page a test expects empty, so absence checks
 * would pass; the fixture fails the test on any of these.
 * @param {import("@playwright/test").Page} page
 * @returns {string[]} filled in as errors happen
 */
export function collectPageErrors(page) {
  /** @type {string[]} */
  const pageErrors = [];
  // The URL names the route that threw, when one test visits several.
  page.on("pageerror", (error) =>
    pageErrors.push(`${page.url()}: ${error.message}`),
  );
  return pageErrors;
}
