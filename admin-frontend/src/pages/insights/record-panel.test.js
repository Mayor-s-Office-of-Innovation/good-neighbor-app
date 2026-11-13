import { afterEach, beforeEach, test, vi } from "vitest";
import assert from "node:assert/strict";
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { adminApi } from "../../services/admin-api.js";
import { RecordPanel, cameBack, markWayBack } from "./record-panel.js";

const check = {
  checkId: "c1",
  siteId: "s1",
  source: "perimeter",
  state: "completed",
  completedAt: "2026-10-02T17:00:00.000Z",
};
const issueReply = {
  issue: {
    issueId: "t1",
    siteId: "s1",
    category: "Unsecured gate",
    severity: 3,
    createdAt: "2026-10-02T17:00:00.000Z",
    responseState: "onTime",
  },
  check,
  site: { siteId: "s1", name: "Example Site" },
};
const checkReply = {
  check,
  issues: [issueReply.issue],
  site: { siteId: "s1", name: "Example Site" },
};

async function flush() {
  for (let i = 0; i < 5; i++)
    await new Promise((resolve) => setImmediate(resolve));
}

/** @param {string} selector @returns {HTMLElement} */
const $ = (selector) =>
  /** @type {HTMLElement} */ (document.querySelector(selector));

/** @param {string} selector */
async function click(selector) {
  $(selector).dispatchEvent(
    new window.MouseEvent("click", { bubbles: true, cancelable: true }),
  );
  await flush();
}

/** @param {Element} target @param {string} type */
const at = (target, type) =>
  target.dispatchEvent(
    new window.MouseEvent(type, { bubbles: true, clientX: 5, clientY: 5 }),
  );

/** The page under the panel: one Issue row whose link opens it. */
function page() {
  const host = document.createElement("div");
  host.innerHTML = `<a href="/x" data-panel-kind="issue" data-panel-id="t1" data-panel-site="s1">Row</a>`;
  document.body.append(host);
  return host;
}

/** @param {{ left?: (hop: any) => void }} [options] */
async function openPanel(options = {}) {
  const host = page();
  const panel = new RecordPanel(host, {
    fullLabel: "Open",
    back: () => "/insights/raw/issues",
    ...options,
  });
  const row = /** @type {HTMLElement} */ (host.querySelector("a"));
  panel.open({ kind: "issue", id: "t1", siteId: "s1" }, row);
  await flush();
  return { host, panel, row };
}

beforeEach(() => {
  vi.spyOn(adminApi, "recordPhotos").mockResolvedValue({
    photos: [],
    notes: [],
  });
  vi.spyOn(adminApi, "reportingIssue").mockResolvedValue(issueReply);
  vi.spyOn(adminApi, "reportingCheck").mockResolvedValue(checkReply);
});

afterEach(() => {
  document.body.innerHTML = "";
  history.replaceState({}, "", "/");
});

test("a press inside the panel that ends on the backdrop, as when selecting text, keeps it open", async () => {
  await openPanel();
  const dialog = $("#insights-panel");
  at($("#insights-panel-title"), "pointerdown");
  at(dialog, "click");
  assert.equal(/** @type {HTMLDialogElement} */ (dialog).open, true);
  // happy-dom lays nothing out, so any point is outside the dialog's box.
  at(dialog, "pointerdown");
  at(dialog, "click");
  assert.equal(document.querySelector("#insights-panel"), null);
});

test("a record link in the panel moves focus to the new record's title", async () => {
  await openPanel();
  await click("#insights-panel [data-parent-check]");
  assert.ok(document.activeElement === $("#insights-panel-title"));
  assert.equal(
    $("#insights-panel-title").textContent,
    t("admin.insights.check", { id: "c1" }),
  );
});

test("a record that fails to load in the panel puts focus on Retry", async () => {
  await openPanel();
  vi.mocked(adminApi.reportingCheck).mockRejectedValueOnce(
    new Error("unavailable"),
  );
  await click("#insights-panel [data-parent-check]");
  assert.ok(document.activeElement === $("#insights-panel-retry"));
  await click("#insights-panel-retry");
  assert.ok(document.activeElement === $("#insights-panel-title"));
});

test("a record the data doesn't have says so in the panel, with no Retry", async () => {
  vi.mocked(adminApi.reportingIssue).mockRejectedValueOnce(
    new Error("issue_not_found"),
  );
  await openPanel();
  assert.equal(
    $('#insights-panel [data-insights-empty="issue_not_found"]').textContent,
    t("admin.insights.record.notFound.issue"),
  );
  assert.equal(document.querySelector("#insights-panel-retry"), null);
});

test("photos are asked for while the record itself loads", async () => {
  /** @type {(value: any) => void} */
  let answer = () => {};
  vi.mocked(adminApi.reportingIssue).mockReturnValueOnce(
    new Promise((resolve) => (answer = resolve)),
  );
  await openPanel();
  assert.equal(vi.mocked(adminApi.recordPhotos).mock.calls.length, 1);
  answer(issueReply);
  await flush();
  assert.equal(vi.mocked(adminApi.recordPhotos).mock.calls.length, 1);
});

test("leaving for a full record reports the record the panel opened on, not the one it shows", async () => {
  const left = vi.fn();
  await openPanel({ left });
  await click("#insights-panel [data-parent-check]");
  $("#insights-panel-full").addEventListener("click", (event) =>
    event.preventDefault(),
  );
  await click("#insights-panel-full");
  assert.deepEqual(left.mock.calls, [
    [{ kind: "issue", id: "t1", siteId: "s1" }],
  ]);
});

test("closing returns focus to the opened row even after the list redrew it", async () => {
  const { host, row } = await openPanel();
  // A Load more under the panel draws every row again.
  const redrawn = /** @type {HTMLElement} */ (row.cloneNode(true));
  row.replaceWith(redrawn);
  await click("#insights-panel-close");
  assert.equal(host.querySelector("#insights-panel"), null);
  assert.ok(document.activeElement === redrawn);
});

test("a click on an Issue row in the panel while text is selected doesn't switch records", async () => {
  vi.mocked(adminApi.reportingIssue).mockResolvedValueOnce(issueReply);
  await openPanel();
  await click("#insights-panel [data-parent-check]");
  const cell = '#insights-panel [data-issue-row="t1"] [data-response]';
  window.getSelection()?.selectAllChildren($(cell));
  await click(cell);
  assert.equal(
    $("#insights-panel-title").textContent,
    t("admin.insights.check", { id: "c1" }),
  );
  window.getSelection()?.removeAllRanges();
  await click(cell);
  assert.notEqual(
    $("#insights-panel-title").textContent,
    t("admin.insights.check", { id: "c1" }),
  );
});

test("the way back is used once: Back to a marked page, or a crumb to it", () => {
  const session = { returning: "" };
  assert.equal(cameBack(session, "/insights/sites/s1"), false);
  markWayBack();
  assert.equal(cameBack(session, "/insights/sites/s1"), true);
  history.replaceState({}, "");
  session.returning = "/insights/sites/s1";
  assert.equal(cameBack(session, "/insights/sites/s1"), true);
  assert.equal(cameBack(session, "/insights/sites/s1"), false);
});
