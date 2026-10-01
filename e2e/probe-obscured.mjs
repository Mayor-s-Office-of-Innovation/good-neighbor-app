// @ts-check
// Probe the focus-obscured `<a>` on bound home under the FIXED runtime.
// Walk Tab; for every stop report obscured + a full hit-test breakdown:
// what elementFromPoint returns, and what elementsUnderPoint (deep variant)
// would return, so we can see what "covers" each element.
import { chromium } from "@playwright/test";
import { installKeyboardRuntime } from "./probe-runtime.js";
import { SITE_CODE } from "./helpers/fixtures.js";

const browser = await chromium.launch();
const context = await browser.newContext({
  baseURL: "http://127.0.0.1:5173",
  viewport: { width: 1280, height: 1000 },
  locale: "en-US",
  timezoneId: "America/Los_Angeles",
  permissions: ["geolocation"],
  geolocation: { latitude: 37.76656393517443, longitude: -122.4213267021692 },
});
const page = await context.newPage();

await page.goto("/");
const otp = page.locator("wa-otp-input#code-input");
await otp.waitFor({ state: "visible", timeout: 15000 });
await otp.locator("#hidden-input").pressSequentially(SITE_CODE);
await page.locator("#continue").click();
await page.locator("#start-check").waitFor({ timeout: 30000 });

await installKeyboardRuntime(page);
await page.evaluate(() => /** @type {any} */ (window).__rampCheckKeyboard.reset());

for (let i = 0; i < 40; i++) {
  await page.keyboard.press("Tab");
  const step = await page.evaluate(() => /** @type {any} */ (window).__rampCheckKeyboard.step());
  if (step.isBody) { console.log(`[${i}] body (wrap)`); continue; }
  console.log(`[${i}] ${step.path} obscured=${step.obscured} rect=${JSON.stringify(step.rect)}`);
  if (step.obscured !== "none") {
    const detail = await page.evaluate(() => {
      // mirror deepActive
      function deepActive() {
        let el = document.activeElement;
        while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
        return el;
      }
      const active = deepActive();
      if (!active) return { error: "no active" };
      const r = active.getBoundingClientRect();
      const root = /** @type {Document | ShadowRoot} */ (active.getRootNode());
      const points = [
        [r.x + r.width / 2, r.y + r.height / 2],
        [r.x + r.width / 4, r.y + r.height / 4],
        [r.right - r.width / 4, r.y + r.height / 4],
        [r.x + r.width / 4, r.bottom - r.height / 4],
        [r.right - r.width / 4, r.bottom - r.height / 4],
      ];
      const describe = (el) => {
        if (!el) return String(el);
        let path = el.localName;
        if (el.id) path += `#${el.id}`;
        if (typeof el.className === "string" && el.className) path += `.${el.className.split(/\s+/).slice(0, 2).join(".")}`;
        const rn = /** @type {ShadowRoot | Document} */ (el.getRootNode());
        const host = /** @type {ShadowRoot} */ (rn instanceof ShadowRoot ? rn.host : null);
        return host ? `${path} [in ${host.localName}${host.id ? "#" + host.id : ""}]` : path;
      };
      const cx = Math.min(Math.max(0, r.x + r.width / 2), window.innerWidth - 1);
      const cy = Math.min(Math.max(0, r.y + r.height / 2), window.innerHeight - 1);
      return {
        activeDesc: describe(active),
        text: (active.textContent ?? "").trim().slice(0, 60),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        center: { cx, cy, vw: window.innerWidth, vh: window.innerHeight },
        hits: points.map(([x, y]) => {
          const hit = root.elementFromPoint(x, y);
          return describe(hit);
        }),
        docHits: points.map(([x, y]) => {
          const hit = document.elementFromPoint(x, y);
          return describe(hit);
        }),
      };
    });
    console.log("   ", JSON.stringify(detail, null, 2));
  }
}

await browser.close();