/*
  Print Lighthouse CI results into the CI job itself: a plain-text table in the
  step log plus GitHub Step Summary ($GITHUB_STEP_SUMMARY) so the numbers show
  on the run's Summary tab without opening artifacts.

  Reads the assertion-results.json + lhr-*.json files that `lhci autorun`
  leaves in <frontend>/.lighthouseci/ (run right after `npx lhci autorun` with
  the same working-directory, so the relative path matches).

  Plain Node, no deps — runs in CI with nothing but the frontend workspace's
  devDependencies.
*/
import { readdirSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), ".lighthouseci");
if (!existsSync(dir)) {
  console.error(
    `No .lighthouseci/ directory at ${dir} — did lhci autorun run?`,
  );
  process.exit(0); // report absence, never break the (non-gating) step
}

const lhrFiles = readdirSync(dir)
  .filter((f) => f.startsWith("lhr-") && f.endsWith(".json"))
  .sort();
if (lhrFiles.length === 0) {
  console.error(
    "No lhr-*.json reports found — Lighthouse runs produced nothing?",
  );
  process.exit(0);
}

/** Median of numeric array. */
const median = (nums) => {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** Human display for an LHR audit result row. */
const fmt = (audit) =>
  audit.displayValue ||
  (audit.score != null ? `${audit.score * 100}/100` : "n/a");

const rows = [];
let worstScore = 1;

for (const f of lhrFiles) {
  const lhr = JSON.parse(readFileSync(join(dir, f), "utf8"));
  const a = lhr.audits;
  worstScore = Math.min(worstScore, lhr.categories.performance.score ?? 1);
  rows.push({
    run: lhrFiles.indexOf(f) + 1,
    perf: (lhr.categories.performance.score * 100).toFixed(0),
    lcp: a["largest-contentful-paint"]?.displayValue || "-",
    tbt: a["total-blocking-time"]?.displayValue || "-",
    cls: a["cumulative-layout-shift"]?.displayValue || "-",
    fcp: a["first-contentful-paint"]?.displayValue || "-",
    jsKb: Math.round(
      (a["resource-summary"]?.details?.items?.find(
        (i) => i.resourceType === "script",
      )?.transferSize ?? 0) / 1024 || 0,
    ),
    cssKb: Math.round(
      (a["resource-summary"]?.details?.items?.find(
        (i) => i.resourceType === "stylesheet",
      )?.transferSize ?? 0) / 1024 || 0,
    ),
  });
}

const head = ["Run", "Perf", "LCP", "TBT", "CLS", "FCP", "JS kB", "CSS kB"];
const width = head.map((h, i) => {
  const key = ["run", "perf", "lcp", "tbt", "cls", "fcp", "jsKb", "cssKb"][i];
  return Math.max(h.length, ...rows.map((r) => String(r[key]).length)) + 2;
});
const line = (cells) =>
  cells.map((c, i) => String(c).padEnd(width[i])).join("");
const rule = "-".repeat(width.reduce((a, b) => a + b, 0));

const table = [
  "",
  `Lighthouse (median of ${rows.length} run${rows.length > 1 ? "s" : ""} shown per column; per-run rows below)`,
  "",
  line(head),
  rule,
  ...rows.map((r) =>
    line([r.run, r.perf, r.lcp, r.tbt, r.cls, r.fcp, r.jsKb, r.cssKb]),
  ),
  "",
  `Worst performance score: ${worstScore * 100}/100 (warn-only gate: >=80, LCP<=4s, TBT<=500ms, CLS<=0.1)`,
  "",
].join("\n");

console.log(table);

// Step Summary tab (only exists on CI).
const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
  const md = [
    "## Lighthouse (prod build, 3 runs)",
    "",
    "| Run | Perf | LCP | TBT | CLS | FCP | JS kB | CSS kB |",
    "|---|---|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.run} | ${r.perf} | ${r.lcp} | ${r.tbt} | ${r.cls} | ${r.fcp} | ${r.jsKb} | ${r.cssKb} |`,
    ),
    "",
    `_Warn-only, non-gating. Full HTML reports in the lighthouse-reports artifact._`,
    "",
  ].join("\n");
  appendFileSync(summaryPath, md);
}
