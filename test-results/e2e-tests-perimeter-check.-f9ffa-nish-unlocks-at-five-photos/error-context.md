# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: e2e/tests/perimeter-check.e2e.spec.js >> perimeter check >> issue photo generates task guidance; Finish unlocks at five photos
- Location: e2e/tests/perimeter-check.e2e.spec.js:35:3

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
  8   | import { SITE_CODE, SITE_NAME } from "./fixtures.js";
  9   | import { typeDelay, isSlowMo } from "./pace.js";
  10  | 
  11  | /**
  12  |  * Bind a fresh browser context to the seeded site through the real code-entry
  13  |  * flow. Typing the code into the OTP field exercises the real input pipeline;
  14  |  * POST /site-code → POST /v1/devices then binds the device session and the
  15  |  * app lands on /today (there is no places gate any more).
  16  |  * @param {import("@playwright/test").Page} page
  17  |  */
  18  | export async function bindSite(page) {
> 19  |   await page.goto("/");
      |              ^ Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
  20  |   const otp = page.locator("wa-otp-input#code-input");
  21  |   await expect(otp).toBeVisible();
  22  |   // wa-otp-input renders a real text input in its shadow root; Playwright CSS
  23  |   // pierces it. Typing exercises the component's own input pipeline (paste and
  24  |   // fill also work, but typing is closest to a real device).
  25  |   await otp.locator("#hidden-input").pressSequentially(SITE_CODE, {
  26  |     ...(typeDelay > 0 ? { delay: typeDelay } : {}),
  27  |   });
  28  |   await page.locator("#continue").click();
  29  |   // The bound site's name is always in the app header; the home heading is
  30  |   // "Start your first check" until the site has a completed check (a fresh
  31  |   // table, as in CI), so it is not a reliable binding signal.
  32  |   await expect(page.locator(".app__title")).toHaveText(SITE_NAME, {
  33  |     timeout: 30_000,
  34  |   });
  35  |   await expect(page.locator("#start-check")).toBeVisible();
  36  | }
  37  | 
  38  | /**
  39  |  * Start a perimeter check and return the photo roll's add-photo tile, which
  40  |  * is the first thing the capture view renders.
  41  |  * @param {import("@playwright/test").Page} page
  42  |  */
  43  | export async function startCheck(page) {
  44  |   await page.locator("#start-check").click();
  45  |   const addTile = page.locator("#add-photo");
  46  |   await expect(addTile).toBeVisible();
  47  |   return addTile;
  48  | }
  49  | 
  50  | /**
  51  |  * Upload one photo into the photo roll.
  52  |  * The hidden `#file-input` sits inside <perimeter-check>'s light DOM.
  53  |  * @param {import("@playwright/test").Page} page
  54  |  * @param {string} filePath
  55  |  */
  56  | export async function addPhoto(page, filePath) {
  57  |   const addTile = page.locator("#add-photo");
  58  |   await expect(addTile).toBeVisible();
  59  |   if (isSlowMo) {
  60  |     // In slow-mo, make the tap visible without triggering the real camera
  61  |     // handoff (the tile click opens the native file picker; Playwright
  62  |     // intercepts file choosers only with a listener, so clicking would hang
  63  |     // headed runs). A brief highlight + pause stands in for "the user tapped".
  64  |     await addTile
  65  |       .evaluate((el) => el.classList.add("e2e-tap-flash"))
  66  |       .catch(() => {});
  67  |     await page.waitForTimeout(typeDelay * 4 || 800);
  68  |     await addTile
  69  |       .evaluate((el) => el.classList.remove("e2e-tap-flash"))
  70  |       .catch(() => {});
  71  |   }
  72  |   await page
  73  |     .locator("#file-input")
  74  |     .evaluate((el) => {
  75  |       /** @type {HTMLInputElement} */ (el).value = "";
  76  |     })
  77  |     .catch(() => {});
  78  |   await page.locator("#file-input").setInputFiles(filePath, { timeout: 5_000 });
  79  | }
  80  | 
  81  | /**
  82  |  * Finish the check from the capture screen and wait for home.
  83  |  * Finish carries `disabled` until the completion rule is met (five photos or
  84  |  * one description), so callers assert on that before calling this.
  85  |  * @param {import("@playwright/test").Page} page
  86  |  */
  87  | export async function finishCheck(page) {
  88  |   const done = page.locator("#done-check");
  89  |   await expect(done).toBeEnabled();
  90  |   await done.click();
  91  |   await expect(page.locator("#start-check")).toBeVisible({ timeout: 30_000 });
  92  | }
  93  | 
  94  | /**
  95  |  * The home tray that holds only THIS check's fresh cards. GET /v1/tasks also
  96  |  * returns older persisted tasks from previous runs (DDB Local keeps state),
  97  |  * which render in a separate section.
  98  |  * @param {import("@playwright/test").Page} page
  99  |  */
  100 | export function newResultsTray(page) {
  101 |   return page.locator('section[aria-label="New analysis results"]');
  102 | }
  103 | 
  104 | /**
  105 |  * Dismiss every generated card in the NEW results tray via its trash button.
  106 |  * Delete flow: trash (data-analysis-action="delete") → confirm dialog →
  107 |  * rejectAnalysisCondition → the card hides behind a 5s undo toast, and the
  108 |  * tray re-renders. Always drive the FIRST remaining card; when the last card's
  109 |  * deletion lands, the empty tray renders its "resolved or deleted" placeholder,
  110 |  * so expect the section to lose its cards.
  111 |  *
  112 |  * NEW cards hydrate in waves (session items render first, then migrate to
  113 |  * backend task cards as listTasks polls land), so the tray count is only
  114 |  * trusted once it stops changing across a settle window. Returns how many
  115 |  * cards were seen at the settled peak.
  116 |  * @param {import("@playwright/test").Page} page
  117 |  * @returns {Promise<number>}
  118 |  */
  119 | export async function dismissAllNewResults(page) {
```