import { test } from "vitest";
import assert from "node:assert/strict";
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { formatInstant } from "./insights.templates.js";
import { issueBodyView, recordFailedView } from "./record.templates.js";

/** @param {string} html */
function parse(html) {
  const box = document.createElement("div");
  box.innerHTML = html;
  return box;
}

/** @param {Record<string, any>} issue */
const issueBody = (issue) =>
  parse(
    issueBodyView({
      reply: {
        issue: {
          issueId: "t1",
          siteId: "s1",
          category: "Unsecured gate",
          severity: 3,
          createdAt: "2026-10-02T17:00:00.000Z",
          ...issue,
        },
        check: null,
      },
      checkHref: "",
      level: 2,
      idPrefix: "insights-record",
    }),
  );

test("an Issue sent to 311 names its primary action", () => {
  const body = issueBody({ type: "city_escalation" });
  assert.equal(
    body.querySelector('[data-fact="action"] dd')?.textContent,
    t("admin.insights.record.action.cityEscalation"),
  );
});

test("an Issue with no recorded type says so as its primary action", () => {
  const body = issueBody({ type: null });
  assert.equal(
    body.querySelector('[data-fact="action"] dd')?.textContent,
    t("admin.insights.raw.notRecorded"),
  );
});

test("latest activity at the same moment as the response isn't listed twice", () => {
  const body = issueBody({
    firstResponseAt: "2026-10-03T17:00:00.000Z",
    latestActivityAt: "2026-10-03T17:00:00Z",
  });
  assert.deepEqual(
    [...body.querySelectorAll("[data-event]")].map((li) =>
      li.getAttribute("data-event"),
    ),
    ["created", "firstResponse"],
  );
});

test("latest activity after the response is listed last", () => {
  const body = issueBody({
    firstResponseAt: "2026-10-03T17:00:00.000Z",
    latestActivityAt: "2026-10-04T09:00:00.000Z",
  });
  assert.deepEqual(
    [...body.querySelectorAll("[data-event]")].map((li) => [
      li.getAttribute("data-event"),
      li.querySelector("time")?.textContent,
    ]),
    [
      ["created", formatInstant("2026-10-02T17:00:00.000Z")],
      ["firstResponse", formatInstant("2026-10-03T17:00:00.000Z")],
      ["latest", formatInstant("2026-10-04T09:00:00.000Z")],
    ],
  );
});

test("a record that isn't there says so for good, with no Retry", () => {
  const view = parse(
    recordFailedView("check", new Error("check_not_found"), "x-retry"),
  );
  assert.equal(
    view.querySelector('[data-insights-empty="check_not_found"]')?.textContent,
    t("admin.insights.record.notFound.check"),
  );
  assert.equal(view.querySelector("#x-retry"), null);
  const twoSites = parse(
    recordFailedView("issue", new Error("site_id_required"), "x-retry"),
  );
  assert.equal(
    twoSites.querySelector('[data-insights-empty="site_id_required"]')
      ?.textContent,
    t("admin.insights.record.needsSite.issue"),
  );
});

test("any other failure says why and offers Retry", () => {
  const view = parse(
    recordFailedView("issue", new Error("unavailable"), "x-retry"),
  );
  assert.ok(
    view
      .querySelector("[data-insights-failed] p")
      ?.textContent?.startsWith(t("admin.insights.record.failed.issue")),
  );
  assert.equal(view.querySelector("#x-retry")?.textContent, t("common.retry"));
});
