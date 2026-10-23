// @ts-check
/*
  `npm run a11y:report -w e2e [-- <playwright test args>]`

  Runs the accessibility spec, then opens a screenshot-first demo report.
  The standard Playwright HTML report is also generated. A caller-supplied
  --reporter replaces these defaults and skips the automatic report viewer.
  A script, not a one-line
  `a && b`, because npm appends extra arguments to the END of a script
  string, so `-- -g reports` must be routed to `playwright test` by hand.

  Stop any dev servers first: the suite boots its own stack and refuses to
  attach to a running one.
*/
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const customReporter = args.some(
  (arg) => arg === "--reporter" || arg.startsWith("--reporter="),
);
const run = (/** @type {string[]} */ cmd) =>
  spawnSync("npx", cmd, {
    stdio: "inherit",
    // CLI reporter selection replaces config options, including open: "never".
    // Prevent the standard HTML reporter from blocking on its own viewer.
    env: { ...process.env, PLAYWRIGHT_HTML_OPEN: "never" },
    shell: process.platform === "win32",
  });

const test = run([
  "playwright",
  "test",
  "tests/a11y.e2e.spec.js",
  ...(customReporter ? [] : ["--reporter=list,html,ramp-check/reporter"]),
  ...args,
]);
// Findings fail tests by design, but the default reporters still write a report.
// A custom reporter may not write one; don't open a stale report in that case.
const show =
  !customReporter && test.status !== null
    ? run(["playwright", "show-report", "ramp-check-report"])
    : undefined;
process.exitCode = test.status ?? show?.status ?? 1;
