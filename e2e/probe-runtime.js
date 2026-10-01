// Probe-only runtime helpers. Installs ramp-check's keyboard runtime verbatim
// plus a small driver that walks Tab to a target and runs the same
// computed-style + padded-screenshot comparison the keyboard audit runs.
import { readFileSync } from "node:fs";

/**
 * Install ramp-check's in-page keyboard runtime by importing the module's own
 * runtime source (evaluated via addInitScript like the audit does).
 * @param {import("@playwright/test").Page} page
 */
export async function installKeyboardRuntime(page) {
  // Extract the runtime function source from ramp-check's keyboard.js and
  // evaluate it in the page (it's self-contained: installs __rampCheckKeyboard).
  const src = readFileSync(
    new URL("../node_modules/ramp-check/src/checks/keyboard.js", import.meta.url),
    "utf8",
  );
  // The runtime is the `function keyboardRuntime({ props }) {...}` definition.
  const match = src.match(/function keyboardRuntime\([\s\S]*?\n}\n/);
  if (!match) throw new Error("keyboardRuntime not found in ramp-check source");
  const runtimeSrc = match[0];
  // Props list the runtime expects (mirrors FOCUS_PROPS in keyboard.js).
  const props = [
    "outline-style",
    "outline-width",
    "outline-color",
    "outline-offset",
    "box-shadow",
    "border-top-color",
    "border-right-color",
    "border-bottom-color",
    "border-left-color",
    "border-top-width",
    "background-color",
    "color",
    "text-decoration-line",
    "filter",
    "transform",
  ];
  await page.evaluate(
    ([runtimeSrc, props]) => {
      // eslint-disable-next-line no-eval
      (0, eval)(`(${runtimeSrc})`)({ props });
    },
    /** @type {[string, string[]]} */ ([runtimeSrc, props]),
  );
}

/**
 * Walk Tab until focus reaches the host (delegatesFocus lands on the hidden
 * input), then run ramp-check's own comparison: computed-style diff, plus the
 * padded screenshot pair used by screenshotChanges(). Reports rect geometry
 * of input vs segments and which segment shows the ring.
 * @param {import("@playwright/test").Page} page
 * @param {string} hostSelector
 */
export async function focusNotVisibleProbe(page, hostSelector) {
  const walk = await page.evaluate(
    (sel) => {
      const w = /** @type {any} */ (window);
      const k = w.__rampCheckKeyboard;
      k.reset();
      const host = document.querySelector(sel);
      /** @type {number} */
      let steps = 0;
      const FOCUS_PROPS = [
        "outline-style",
        "outline-width",
        "outline-color",
        "outline-offset",
        "box-shadow",
        "border-top-color",
        "border-right-color",
        "border-bottom-color",
        "border-left-color",
        "border-top-width",
        "background-color",
        "color",
        "text-decoration-line",
        "filter",
        "transform",
      ];
      return (async () => {
        for (; steps < 40; steps++) {
          const before = k.step();
          await new Promise((r) => setTimeout(r, 50));
          window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
          // Cannot synthesize real Tab via evaluate; driver presses via CDP below.
          break;
        }
        return null;
      })();
    },
    hostSelector,
  );
  void walk;
  // Drive with real Tab presses (page.keyboard), checking after each.
  await page.evaluate(() => /** @type {any} */ (window).__rampCheckKeyboard.reset());
  /** @type {{ path: string, styleDiff: string[], rect: unknown } | null} */
  let hit = null;
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab");
    const step = await page.evaluate(() => /** @type {any} */ (window).__rampCheckKeyboard.step());
    if (String(step.path).includes(hostSelector)) {
      hit = step;
      break;
    }
    if (step.isBody) continue;
  }
  if (!hit) return { found: false };

  // Screenshot pair, same as screenshotChanges().
  const rect = /** @type {{ x: number, y: number, width: number, height: number }} */ (hit.rect);
  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
  const pad = 8;
  const x = Math.max(0, rect.x - pad);
  const y = Math.max(0, rect.y - pad);
  const width = Math.min(viewport.width - x, rect.width + pad * 2);
  const height = Math.min(viewport.height - y, rect.height + pad * 2);
  const clip = { x, y, width, height };
  await page.evaluate(() => /** @type {any} */ (window).__rampCheckKeyboard.blur());
  const blurred = await page.screenshot({ clip, animations: "disabled" });
  await page.evaluate((i) => /** @type {any} */ (window).__rampCheckKeyboard.focus(i), hit.index);
  const focused = await page.screenshot({ clip, animations: "disabled" });
  const pixelsChanged = !blurred.equals(focused);

  // Where is the ring, really? Input vs segments vs first segment.
  const geometry = await page.evaluate(
    (sel) => {
      const host = document.querySelector(sel);
      const sr = /** @type {ShadowRoot} */ (host.shadowRoot);
      const r = (el) => {
        const b = el.getBoundingClientRect();
        return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
      };
      const input = sr.querySelector("#hidden-input");
      const segments = sr.querySelector(".segments");
      const firstSegment = sr.querySelector(".segment");
      return {
        input: r(input),
        segments: r(segments),
        firstSegment: r(firstSegment),
        activeSegment: r(sr.querySelector(".segment--active") ?? firstSegment),
        caret: !!sr.querySelector(".caret"),
      };
    },
    hostSelector,
  );
  return { found: true, step: hit, pixelsChanged, clip, geometry };
}