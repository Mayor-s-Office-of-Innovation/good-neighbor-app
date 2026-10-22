// @ts-check
/*
  `npm run a11y:report -w e2e [-- <playwright test args>]`

  Runs the accessibility spec, then opens a screenshot-first demo report.
  The standard Playwright HTML report is also generated. A script, not a one-line
  `a && b`, because npm appends extra arguments to the END of a script
  string, so `-- -g reports` must be routed to `playwright test` by hand.

  Stop any dev servers first: the suite boots its own stack and refuses to
  attach to a running one.
*/
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const run = (/** @type {string[]} */ cmd) =>
  spawnSync("npx", cmd, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });

const test = run([
  "playwright",
  "test",
  "tests/a11y.e2e.spec.js",
  ...args,
  "--reporter=list,html,ramp-check/reporter",
]);
// Findings fail tests by design; the report is the point, so open it either way.
const show = run(["playwright", "show-report", "ramp-check-report"]);
process.exitCode = test.status ?? show.status ?? 1;
