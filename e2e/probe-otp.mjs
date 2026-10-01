// @ts-check
// Probe the focus-not-visible finding on wa-otp-input#code-input:
// where is the hidden input, where is the ring, what's inside an 8px-padded
// clip around the input before/after focus?
import { chromium } from "@playwright/test";
import { installKeyboardRuntime, focusNotVisibleProbe } from "./probe-runtime.js";

const SITE_CODE = "GUBSJE";

const browser = await chromium.launch();
const context = await browser.newContext({
  baseURL: "http://127.0.0.1:5173",
  locale: "en-US",
  timezoneId: "America/Los_Angeles",
});
const page = await context.newPage();

await page.goto("/");
const otp = page.locator("wa-otp-input#code-input");
await otp.waitFor({ state: "visible", timeout: 15000 });

await installKeyboardRuntime(page);

// Geometry, computed styles, and pixel-pair for the hidden input via Tab.
const result = await focusNotVisibleProbe(page, "wa-otp-input#code-input");
console.log("== focus-not-visible probe (Tab-driven) ==");
console.log(JSON.stringify(result, null, 1));

// Then a direct click-focus (mouse path, delegatesFocus to segments container?)
console.log("\n== manual click on segments ==");
const seg = otp.locator(".segments");
await seg.click();
await page.waitForTimeout(300);
await page.evaluate(() => {
  const dom = /** @type {any} */ (window).__rampCheckProbe;
  const host = document.querySelector("wa-otp-input#code-input");
  const input = host.shadowRoot.querySelector("#hidden-input");
  const active = dom.deepActive();
  console.log; // noop
  window.__probeOut = {
    activePath: dom.pathFor(active),
    inputRect: input.getBoundingClientRect().toJSON(),
    segmentsRect: host.shadowRoot.querySelector(".segments").getBoundingClientRect().toJSON(),
    caret: !!host.shadowRoot.querySelector(".caret"),
    hostMatchesFocus: host.matches(":focus"),
  };
});
const out = await page.evaluate(() => /** @type {any} */ (window).__probeOut);
console.log(JSON.stringify(out, null, 1));

await browser.close();