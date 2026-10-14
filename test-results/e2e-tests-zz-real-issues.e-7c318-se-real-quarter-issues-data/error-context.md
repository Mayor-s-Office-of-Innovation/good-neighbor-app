# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: e2e/tests/zz-real-issues.e2e.spec.js >> diagnose real quarter issues data
- Location: e2e/tests/zz-real-issues.e2e.spec.js:6:1

# Error details

```
Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
Call log:
  - navigating to "/", waiting until "load"

```

# Test source

```ts
  1   | /*
  2   |   UI helpers for the Good Neighbor field app. Everything here drives the real
  3   |   user paths — site-code entry, the flat photo roll capture screen, and the
  4   |   home results tray — against the local harness (backend :3001 behind the Vite
  5   |   proxy on :5173).
  6   | */
  7   | import { expect } from "@playwright/test";
  8   | import { t } from "./i18n.js";
  9   | import { SITE_CODE, SITE_NAME, PHOTO_CLEAR } from "./fixtures.js";
  10  | import { setAnalyzerFixture } from "./analyzer-control.js";
  11  | import { typeDelay, isSlowMo } from "./pace.js";
  12  | 
  13  | /**
  14  |  * Bind a fresh browser context to the seeded site through the real code-entry
  15  |  * flow. Typing the code into the OTP field exercises the real input pipeline;
  16  |  * POST /site-code → POST /v1/devices then binds the device session and the
  17  |  * app lands on /today (there is no places gate any more).
  18  |  * @param {import("@playwright/test").Page} page
  19  |  * @param {{ siteCode?: string, siteName?: string }} [options]
  20  |  */
  21  | export async function bindSite(page, options = {}) {
  22  |   const siteCode = options.siteCode || SITE_CODE;
  23  |   const siteName = options.siteName || SITE_NAME;
> 24  |   await page.goto("/");
      |              ^ Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
  25  |   const otp = page.locator("wa-otp-input#code-input");
  26  |   await expect(otp).toBeVisible();
  27  |   // wa-otp-input renders a real text input in its shadow root; Playwright CSS
  28  |   // pierces it. Typing exercises the component's own input pipeline (paste and
  29  |   // fill also work, but typing is closest to a real device).
  30  |   await otp.locator("#hidden-input").pressSequentially(siteCode, {
  31  |     ...(typeDelay > 0 ? { delay: typeDelay } : {}),
  32  |   });
  33  |   await page.locator("#continue").click();
  34  |   // The bound site's name is always in the app header; the home heading is
  35  |   // "Start your first check" until the site has a completed check (a fresh
  36  |   // table, as in CI), so it is not a reliable binding signal.
  37  |   await expect(page.locator(".app__title")).toHaveText(siteName, {
  38  |     timeout: 30_000,
  39  |   });
  40  |   await expect(page.locator("#start-check")).toBeVisible();
  41  | }
  42  | 
  43  | /**
  44  |  * Start a perimeter check and return the photo roll's add-photo tile, which
  45  |  * is the first thing the capture view renders.
  46  |  * @param {import("@playwright/test").Page} page
  47  |  */
  48  | export async function startCheck(page) {
  49  |   await page.locator("#start-check").click();
  50  |   const addTile = page.locator("#add-photo");
  51  |   await expect(addTile).toBeVisible();
  52  |   return addTile;
  53  | }
  54  | 
  55  | /**
  56  |  * Upload one photo into the photo roll.
  57  |  * The hidden `#file-input` sits inside <perimeter-check>'s light DOM.
  58  |  * @param {import("@playwright/test").Page} page
  59  |  * @param {string} filePath
  60  |  */
  61  | export async function addPhoto(page, filePath) {
  62  |   const addTile = page.locator("#add-photo");
  63  |   await expect(addTile).toBeVisible();
  64  |   if (isSlowMo) {
  65  |     // In slow-mo, make the tap visible without triggering the real camera
  66  |     // handoff (the tile click opens the native file picker; Playwright
  67  |     // intercepts file choosers only with a listener, so clicking would hang
  68  |     // headed runs). A brief highlight + pause stands in for "the user tapped".
  69  |     await addTile
  70  |       .evaluate((el) => el.classList.add("e2e-tap-flash"))
  71  |       .catch(() => {});
  72  |     await page.waitForTimeout(typeDelay * 4 || 800);
  73  |     await addTile
  74  |       .evaluate((el) => el.classList.remove("e2e-tap-flash"))
  75  |       .catch(() => {});
  76  |   }
  77  |   await page
  78  |     .locator("#file-input")
  79  |     .evaluate((el) => {
  80  |       /** @type {HTMLInputElement} */ (el).value = "";
  81  |     })
  82  |     .catch(() => {});
  83  |   await page.locator("#file-input").setInputFiles(filePath, { timeout: 5_000 });
  84  | }
  85  | 
  86  | /**
  87  |  * Finish the check from the capture screen and wait for home.
  88  |  * Finish carries `disabled` until the completion rule is met (three photos or
  89  |  * one description), so callers assert on that before calling this.
  90  |  * @param {import("@playwright/test").Page} page
  91  |  */
  92  | export async function finishCheck(page) {
  93  |   const done = page.locator("#done-check");
  94  |   await expect(done).toBeEnabled();
  95  |   await done.click();
  96  |   await expect(page.locator("#start-check")).toBeVisible({ timeout: 30_000 });
  97  | }
  98  | 
  99  | /**
  100 |  * The To do tab's blue tray for the newest check. GET /v1/tasks can also
  101 |  * return older persisted tasks, which render in historical check groups.
  102 |  * @param {import("@playwright/test").Page} page
  103 |  */
  104 | export function newResultsTray(page) {
  105 |   return page.locator(`section[aria-label="${t("today.newResults.aria")}"]`);
  106 | }
  107 | 
  108 | /**
  109 |  * Dismiss every generated card in the NEW results tray via its trash button.
  110 |  * Delete flow: trash (data-analysis-action="delete") → confirm dialog →
  111 |  * rejectAnalysisCondition → the card hides behind a 5s undo toast, and the
  112 |  * tray re-renders. Always drive the FIRST remaining card; when the last card's
  113 |  * deletion lands, the empty tray renders its "resolved or deleted" placeholder,
  114 |  * so expect the section to lose its cards.
  115 |  *
  116 |  * NEW cards hydrate in waves (session items render first, then migrate to
  117 |  * backend task cards as listTasks polls land), so the tray count is only
  118 |  * trusted once it stops changing across a settle window. Returns how many
  119 |  * cards were seen at the settled peak.
  120 |  * @param {import("@playwright/test").Page} page
  121 |  * @returns {Promise<number>}
  122 |  */
  123 | export async function dismissAllNewResults(page) {
  124 |   const tray = newResultsTray(page);
```