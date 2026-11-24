import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { JobAction, jobButtonView } from "./job-action.js";

/** @typedef {import("./report-job.js").ReportState} ReportState */

const words = {
  busy: "admin.insights.report.generating",
  done: "admin.insights.report.done",
  errors: "admin.insights.report.error",
  refreshFailed: "admin.insights.report.refreshFailed",
};

const label = () => t("admin.insights.report.button");

/** @param {string} state @param {string} [error] @returns {ReportState} */
const report = (state, error = "") =>
  /** @type {ReportState} */ ({
    phase: state,
    count: 1,
    error,
    job: {
      jobId: "j1",
      state,
      error: null,
      expiresAt: "2026-11-05T20:00:00.000Z",
      downloadUrl: null,
      result: null,
    },
  });

/** A job store the test moves by hand. @param {ReportState | null} current */
function fakeJobs(current) {
  return /** @type {any} */ ({
    current,
    retries: 0,
    dismissals: 0,
    retry() {
      this.retries += 1;
      return Promise.resolve();
    },
    dismiss() {
      this.dismissals += 1;
    },
    refresh: () => Promise.resolve(),
    linkFresh: () => false,
  });
}

/** @param {ReportState | null} current */
function mount(current) {
  const host = document.createElement("div");
  host.innerHTML = jobButtonView("job", label());
  document.body.append(host);
  const jobs = fakeJobs(current);
  const action = new JobAction(host, { id: "job", jobs, words });
  return { host, jobs, action };
}

/** @param {Element} host @param {string} selector */
const shown = (host, selector) =>
  host.querySelector(selector)?.textContent?.trim() ?? null;

afterEach(() => {
  document.body.replaceChildren();
});

test("a job whose progress can't be read says so, then clears once a read works", () => {
  const { host, jobs, action } = mount(report("running", "socket hang up"));
  action.draw({ label: label(), off: false, why: "" });
  assert.equal(shown(host, "#job"), t("admin.insights.job.cantCheck"));
  assert.equal(
    shown(host, "[data-job-status]"),
    t("admin.insights.job.cantCheck"),
  );
  jobs.current = report("running");
  action.draw({ label: label(), off: false, why: "" });
  assert.equal(shown(host, "#job"), t(words.busy));
  assert.equal(shown(host, "[data-job-status]"), "");
});

test("a new run removes the last run's dialog, so it can't retry or dismiss the new one", () => {
  const { host, jobs, action } = mount(report("failed", "job_timed_out"));
  action.draw({ label: label(), off: false, why: "" });
  const dialog = /** @type {HTMLDialogElement} */ (
    host.querySelector("#job-done")
  );
  assert.equal(dialog.open, true);
  jobs.current = report("queued");
  action.draw({ label: label(), off: false, why: "" });
  assert.equal(!!host.querySelector("#job-done"), false);
  dialog.dispatchEvent(new Event("close"));
  assert.deepEqual([jobs.retries, jobs.dismissals], [0, 0]);
});

test("a click on the switched-off button reaches no page handler", () => {
  const { host, action } = mount(null);
  let clicks = 0;
  host.addEventListener("click", () => (clicks += 1));
  action.draw({
    label: label(),
    off: true,
    why: t("admin.insights.report.needSites"),
  });
  /** @type {HTMLButtonElement} */ (host.querySelector("#job")).click();
  assert.equal(clicks, 0);
  action.draw({ label: label(), off: false, why: "" });
  /** @type {HTMLButtonElement} */ (host.querySelector("#job")).click();
  assert.equal(clicks, 1);
});
