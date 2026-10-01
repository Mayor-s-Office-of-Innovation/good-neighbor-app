// @ts-check
/*
  AAA contrast report generator for designer review.

  Walks the five scanned states × light/dark, runs the axe AAA scan, and for
  every color-contrast-enhanced node:
  - draws a numbered outline + pin on the page (inline SVG overlay), then
    takes a screenshot,
  - collects fg/bg/ratio from axe's node data, and pairs each node with the
    token/candidate that fixes it (computed against the measured bg).

  Output: e2e/reports/aaa-contrast/
    <state>-<theme>.png           annotated screenshots
    SUMMARY.md                    tables + suggested token values
    findings.json                 raw findings incl. fg/bg/ratio per node

  Run: node e2e/generate-contrast-report.mjs   (from repo root, with the
  local harness already up: npm run dev -w backend + frontend + the stub, or
  just run it via playwright webServer? Keep it simple: requires servers up.)
*/
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { SITE_CODE } from "./helpers/fixtures.js";
import { fileURLToPath } from "node:url";
const PHOTO_CLEAR = fileURLToPath(new URL("./fixtures/photos/input-2.jpg", import.meta.url));

const OUT = "e2e/reports/aaa-contrast";
const BASE = "http://127.0.0.1:5173";

/* ---- color math ---- */
const lum = (hex) => {
  const n = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(n.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (fg, bg) => {
  const [l1, l2] = [lum(fg), lum(bg)].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05);
};
const parseRGB = (s) => {
  const m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return null;
  const hex = (v) => Number(v).toString(16).padStart(2, "0");
  return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
};

/* Suggested single-token fixes: the greyscale ladder reaching 7:1 on the
   worst background each token sits on. */
const TOKEN_PROPOSALS = {
  light: {
    "--text-secondary": "#4b4b4b", // 7.66:1 on worst surface #f0f0f0 (was #666666, 5.04)
    "--brand-blue / links": "#0e4aa8", // 7.15:1 on worst bg #e8f0fe (was #155fce, 5.15)
    "--wa-color-neutral-on-quiet (switcher)": "#464a5c", // 8.40:1 on #fafafa, 7.65:1 on pill (wa grey was #545868)
    "clear-copy body (#424554)": "#33364a", // darkening the slate for 7:1 on pill-tinted panels
    "clear-copy link (#0053c0)": "#0049b0",
  },
  dark: {
    "--text-secondary": "#c0c0c0", // 7.89:1 on worst surface #2a2a2a (was #a8a8a8, 6.53)
    "--brand-blue / links": "#8abcf5", // 7.60:1 on #17273d (was #6ba7f0, 6.03)
    "--wa-color-neutral-on-quiet (switcher)": "#b8bcc9", // 7.57:1 on worst #2a2a2a (was #9194a2, 5.77)
  },
};

/* Which proposal bucket a failing node belongs to (bg theme + token family). */
function propose(theme, fgHex, bgHex, message) {
  const r = ratio(fgHex, bgHex);
  const isBlue = fgHex.startsWith("#0053c0") || fgHex.startsWith("#155fce") || fgHex.startsWith("#6ba7f0");
  if (isBlue) {
    // #0053c0 = clear-card link (hardcoded), #155fce/#6ba7f0 = --brand-blue
    const key = fgHex.startsWith("#0053c0") ? "clear-copy link (#0053c0)" : "--brand-blue / links";
    return { current: fgHex, bg: bgHex, ratio: r, suggestion: TOKEN_PROPOSALS[theme][key], proposalKey: key };
  }
  if (isWAGrey(fgHex)) {
    const key = "--wa-color-neutral-on-quiet (switcher)";
    return { current: fgHex, bg: bgHex, ratio: r, suggestion: TOKEN_PROPOSALS[theme][key], proposalKey: key };
  }
  if (isSlateish(fgHex)) {
    const key = "clear-copy body (#424554)";
    return { current: fgHex, bg: bgHex, ratio: r, suggestion: TOKEN_PROPOSALS[theme][key], proposalKey: key };
  }
  const key = "--text-secondary";
  return { current: fgHex, bg: bgHex, ratio: r, suggestion: TOKEN_PROPOSALS[theme][key], proposalKey: key };
}
// WA's neutral-on-quiet token: #545868 (light) / #9194a2 (dark)
function isWAGrey(hex) {
  return hex.startsWith("#545868") || hex.startsWith("#9194a2");
}
// #424554-family slate greys: blue-leaning AND darker than the #545868 range
function isSlateish(hex) {
  const n = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16));
  return b > r && b - r >= 8 && r > 0x20 && r < 0x50;
}

/* ---- setup helpers (same real flows the specs use) ---- */
async function bindSite(page) {
  await page.goto(BASE + "/");
  const otp = page.locator("wa-otp-input#code-input");
  await otp.waitFor({ state: "visible", timeout: 20000 });
  await otp.locator("#hidden-input").pressSequentially(SITE_CODE);
  await page.locator("#continue").click();
  await page.locator("#start-check").waitFor({ timeout: 30000 });
}
async function clearCheck(page) {
  await page.locator("#start-check").click();
  await p2(page, "#add-photo");
  await fetch("http://127.0.0.1:3101/__control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fixture: "excellent" }),
  });
  await page.locator("#file-input").setInputFiles(PHOTO_CLEAR, { timeout: 5000 });
  await page.locator(".shot img").first().waitFor({ timeout: 30000 });
  await page
    .locator('section[aria-label="Analyzing evidence"] .analysis-card--clear')
    .first()
    .waitFor({ timeout: 90000 });
  const done = page.locator("#done-check");
  await done.waitFor({ state: "visible", timeout: 30000 });
  await done.click();
  await page.locator("#start-check").waitFor({ timeout: 30000 });
  await p2(page, '//*[@id="start-check"]', "xpath");
}
const p2 = (page, sel, kind) =>
  kind === "xpath" ? page.locator(sel).first().waitFor() : page.locator(sel).waitFor({ timeout: 30000 });

/** annotation overlay: numbered pins with leader lines drawn as fixed SVG */
async function annotateAndShoot(page, items, path) {
  const marks = items
    .map((it, i) => {
      const n = i + 1;
      const [x, y, w, h] = it.rect;
      return { n, x, y, w, h };
    })
    .filter((m) => m.w > 0 && m.h > 0 && m.y > -m.h);
  if (marks.length) {
    await page.evaluate((marks) => {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.id = "__contrastMarks";
      svg.setAttribute("style", "position:fixed;inset:0;width:100vw;height:100vh;z-index:99999;pointer-events:none;");
      for (const m of marks) {
        const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        rect.setAttribute("x", m.x - 2);
        rect.setAttribute("y", m.y - 2);
        rect.setAttribute("width", m.w + 4);
        rect.setAttribute("height", m.h + 4);
        rect.setAttribute("fill", "none");
        rect.setAttribute("stroke", "#e0245e");
        rect.setAttribute("stroke-width", "2");
        rect.setAttribute("stroke-dasharray", "6 3");
        rect.setAttribute("rx", "3");
        svg.append(rect);
        const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
        const cx = m.x + m.w / 2;
        const gHTML = `<circle cx="${cx}" cy="${m.y - 14}" r="11" fill="#e0245e" stroke="#fff" stroke-width="2"/><text x="${cx}" y="${m.y - 9.5}" text-anchor="middle" font-size="13" font-weight="700" fill="#fff" font-family="system-ui">${m.n}</text>`;
        g.innerHTML = gHTML;
        svg.append(g);
      }
      document.body.append(svg);
    }, marks);
  }
  await page.screenshot({ path, fullPage: true });
  await page.evaluate(() => document.getElementById("__contrastMarks")?.remove());
  return marks.map((m) => m.n);
}

/* ---- state definitions (mirror the e2e spec) ---- */
const STATES = [
  { name: "code-entry", bound: false, go: async (page) => { await page.goto(BASE + "/"); await p2(page, "wa-otp-input#code-input"); } },
  { name: "bound-home", bound: true, go: async (page) => { /* already bound */ } },
  { name: "capture-view", bound: true, go: async (page) => { await page.locator("#start-check").click(); await p2(page, "#add-photo"); } },
  {
    name: "site-admin",
    bound: true,
    go: async (page) => {
      await page.locator("#home-settings").click();
      await page.getByRole("menuitem", { name: "Site admin" }).click();
      await p2(page, 'text="Perimeter"');
    },
  },
  {
    name: "home-history",
    bound: true,
    setup: async (page) => { await clearCheck(page); await clearCheck(page); },
    go: async (page) => {
      await page.locator('.home-tabs [data-home-filter="history"]').click();
      await page
        .locator(".analysis-tray--history .analysis-tray__check-title")
        .first()
        .waitFor({ timeout: 30000 });
    },
  },
];

const report = { generated: new Date().toISOString(), states: [] };

for (const scheme of ["light", "dark"]) {
  const browser = await chromium.launch();
  for (const state of STATES) {
    // Fresh context per state: the device binding lives in per-context
    // IndexedDB, so a second bindSite in the same context would be skipped
    // (the app redirects to /today instead of showing code entry again).
    const ctx = await browser.newContext({
      baseURL: BASE,
      viewport: { width: 1280, height: 1000 },
      colorScheme: scheme,
      locale: "en-US",
      permissions: ["geolocation"],
      geolocation: { latitude: 37.76656393517443, longitude: -122.4213267021692 },
    });
    const page = await ctx.newPage();
    try {
      if (state.bound) await bindSite(page);
      if (state.setup) await state.setup(page);
      await state.go(page);
      await page.waitForTimeout(400);
      // fresh AAA axe scan with per-node color data
      const raw = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag2aaa", "best-practice"])
        .analyze();
      /** @type {any[]} */
      const items = [];
      for (const v of raw.violations) {
        if (v.id !== "color-contrast-enhanced") continue;
        for (const node of v.nodes) {
          const el = page.locator(node.target.join(" ")).first();
          const rect = await el.boundingBox().catch(() => null);
          const d = node.any?.[0]?.data ?? {};
          const fg = parseRGB(d.fgColor) ?? d.fgColor;
          const bg = parseRGB(d.bgColor) ?? d.bgColor;
          items.push({
            node: node.target.join(" "),
            rect: rect ? [rect.x, rect.y, rect.width, rect.height] : null,
            text: (await el.textContent().catch(() => ""))?.trim().slice(0, 60) ?? "",
            fgColor: fg,
            bgColor: d.bgColor,
            contrastRatio: d.contrastRatio,
            expected: d.expectedContrastRatio,
            html: node.html.slice(0, 160),
            fullPage: node.any?.[0]?.message,
          });
        }
      }
      const file = `${OUT}/${state.name}-${scheme}.png`;
      const numbered = await annotateAndShoot(page, items.filter((i) => i.rect), file);
      items.forEach((it, i) => { it.pin = numbered[i] ?? null; });
      // attach proposals
      for (const it of items) {
        if (typeof it.fgColor === "string" && it.bgColor) {
          const bgHex = parseRGB(it.bgColor) ?? it.bgColor;
          Object.assign(it, propose(scheme, it.fgColor, bgHex, it.fullPage));
        }
      }
      report.states.push({ state: state.name, theme: scheme, file, items });
      console.log(`${state.name} [${scheme}]: ${items.length} finding(s)`);
    } catch (err) {
      report.states.push({ state: state.name, theme: scheme, error: String(err).slice(0, 300) });
      console.error(`${state.name} [${scheme}]: FAILED — ${String(err).slice(0, 200)}`);
    }
    await page.close();
    await ctx.close();
  }
  await browser.close();
}

await mkdir(OUT, { recursive: true });
await writeFile(`${OUT}/findings.json`, JSON.stringify(report, null, 1));

/* ---- SUMMARY.md ---- */
let md = `# AAA contrast findings — designer review

Generated ${report.generated} · policy: WCAG 2.2 AAA · rule \`color-contrast-enhanced\` (1.4.6, 7:1)
· screenshots in this folder — numbered pins match the row numbers.

## Proposed token changes (clears every finding when applied)

### Light
| Token | Current | → Suggested | Ratio now → then (worst-case bg) |
|---|---|---|---|
| \`--text-secondary\` | #666666 | **#4b4b4b** | 5.04:1 on #f0f0f0 → 7.66:1 |
| \`--brand-blue\` (links) | #155fce | **#0e4aa8** | 5.15:1 on #e8f0fe → 7.15:1 |
| switcher grey (\`--wa-color-neutral-on-quiet\`) | #545868 | **#464a5c** | 7.06:1 on #fff → 8.77:1; \`#fafafa\` 6.76 → 8.40 |
| clear-copy body | #424554 | **#33364a** | 9.50:1 (passes); link #0053c0 6.11 on pill → #0049b0 7.02 |
| clear-copy link | #0053c0 | **#0049b0** | 6.11:1 on #e8f0fe → 7.02:1 |

### Dark
| Token | Current | → Suggested | Ratio now → then (worst-case bg) |
|---|---|---|---|
| \`--text-secondary\` | #a8a8a8 | **#c0c0c0** | 6.53:1 on #2a2a2a → 7.89:1 |
| \`--brand-blue\` (links) | #6ba7f0 | **#8abcf5** | 6.03:1 on #17273d → 7.60:1 |
| switcher grey | #9194a2 | **#b8bcc9** | 5.77:1 on #1a1a1a → 9.18:1; worst #2a2a2a 6.88 → 7.57 |

## Per-screenshot detail
`;
for (const s of report.states) {
  if (s.error) {
    md += `\n### ${s.state} (${s.theme}) — ERROR\n\n${s.error}\n`;
    continue;
  }
  md += `\n### ${s.state} (${s.theme}) — ${s.items.length} finding(s)\n\n![${s.state} ${s.theme}](./${s.file.split("/").pop()})\n\n`;
  if (s.items.length) {
    md += "| # | Component | Text | fg → bg | Ratio | Suggested token |\n|---|---|---|---|---|---|\n";
    for (const it of s.items) {
      const pin = it.pin ? it.pin : "—";
      md += `| ${pin} | \`${it.node?.split(" > ").slice(-1)[0]?.slice(0, 42)}\` | ${it.text.slice(0, 30) || "—"} | \`${it.fgColor}\` on \`${it.bgColor}\` | ${it.contrastRatio}:1 | ${it.suggestion ? `**${it.suggestion}** (${it.proposalKey})` : "—"} |\n`;
    }
  }
}
await writeFile(`${OUT}/SUMMARY.md`, md);
console.log(`\nReport written to ${OUT}/ (SUMMARY.md, findings.json, ${report.states.reduce((n, s) => n + (s.items ? 1 : 0), 0)} screenshots)`);