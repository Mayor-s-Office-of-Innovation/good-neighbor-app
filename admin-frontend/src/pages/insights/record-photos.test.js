import { afterEach, test, vi } from "vitest";
import assert from "node:assert/strict";
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { adminApi } from "../../services/admin-api.js";
import { formatInstant } from "./insights.templates.js";
import {
  readRecordPhotos,
  recordPhotosView,
  showRecordPhotos,
} from "./record-photos.js";

const NOW = Date.parse("2026-11-04T19:00:00.000Z");
const issue = { kind: /** @type {const} */ ("issue"), id: "t1", siteId: "s1" };

/** @param {string} url @param {number} readAt */
const photo = (url, readAt) => ({
  artifactId: "a1",
  source: /** @type {const} */ ("check"),
  takenAt: "2026-10-02T17:01:00.000Z",
  thumbnailUrl: `${url}-thumb`,
  url,
  urlExpiresAt: new Date(readAt + 300_000).toISOString(),
  urlSeconds: 300,
});

async function flush() {
  for (let i = 0; i < 5; i++)
    await new Promise((resolve) => setImmediate(resolve));
}

/** @returns {HTMLElement} */
function region() {
  const section = document.createElement("section");
  section.setAttribute("data-record-photos", "");
  document.body.append(section);
  return section;
}

/** @param {HTMLElement} at */
async function show(at) {
  const signal = new AbortController().signal;
  void showRecordPhotos(at, readRecordPhotos(at, issue, signal), {
    level: 3,
    signal,
  });
  await flush();
}

afterEach(() => {
  document.body.innerHTML = "";
});

test("a photo with no time on record is still named for screen readers", () => {
  const box = document.createElement("div");
  box.innerHTML = recordPhotosView({
    photos: [{ ...photo("u", NOW), takenAt: null }],
    notes: [],
    level: 3,
  });
  assert.equal(
    box.querySelector("[data-photo-open]")?.getAttribute("aria-label"),
    t("admin.insights.record.photoOpenUndated.check"),
  );
});

test("a supervisors-only refusal removes the photos region", async () => {
  vi.spyOn(adminApi, "recordPhotos").mockRejectedValue(
    new Error("supervisor_required"),
  );
  const at = region();
  await show(at);
  assert.equal(at.isConnected, false);
});

test("a Compliance manager's page doesn't ask for photos it can't read", async () => {
  const read = vi.spyOn(adminApi, "recordPhotos");
  const page = /** @type {any} */ (
    document.createElement("admin-insights-page")
  );
  page.session = { role: "compliance-manager" };
  document.body.append(page);
  const at = region();
  page.append(at);
  await show(at);
  assert.equal(read.mock.calls.length, 0);
  assert.equal(at.isConnected, false);
});

test("a blocked photos request says so and Retry reads them again", async () => {
  const read = vi
    .spyOn(adminApi, "recordPhotos")
    .mockRejectedValueOnce(
      Object.assign(new Error("request_blocked"), { status: 403 }),
    )
    .mockResolvedValue({ photos: [photo("u", NOW)], notes: [] });
  const at = region();
  await show(at);
  assert.ok(
    at
      .querySelector("[data-insights-failed] p")
      ?.textContent?.startsWith(t("admin.insights.record.photosFailed")),
  );
  /** @type {HTMLElement} */ (
    at.querySelector("#insights-photos-retry")
  ).click();
  await flush();
  assert.equal(read.mock.calls.length, 2);
  assert.equal(
    at.querySelector("[data-photo-open]")?.getAttribute("aria-label"),
    t("admin.insights.record.photoOpen.check", {
      time: formatInstant("2026-10-02T17:01:00.000Z"),
    }),
  );
});

test("a photo opened while its link still works opens without asking again", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const read = vi
    .spyOn(adminApi, "recordPhotos")
    .mockResolvedValue({ photos: [photo("first", NOW)], notes: [] });
  const at = region();
  await show(at);
  vi.setSystemTime(NOW + 120_000);
  /** @type {HTMLElement} */ (at.querySelector("[data-photo-open]")).click();
  await flush();
  assert.equal(read.mock.calls.length, 1);
  assert.equal(
    at.querySelector("#insights-photo-viewer img")?.getAttribute("src"),
    "first",
  );
});

test("a photo opened after its link ran out opens with a new link", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const read = vi
    .spyOn(adminApi, "recordPhotos")
    .mockResolvedValueOnce({ photos: [photo("first", NOW)], notes: [] })
    .mockResolvedValue({
      photos: [photo("second", NOW + 300_000)],
      notes: [],
    });
  const at = region();
  await show(at);
  vi.setSystemTime(NOW + 300_000);
  /** @type {HTMLElement} */ (at.querySelector("[data-photo-open]")).click();
  await flush();
  assert.equal(read.mock.calls.length, 2);
  assert.equal(
    at.querySelector("#insights-photo-viewer img")?.getAttribute("src"),
    "second",
  );
  /** @type {HTMLElement} */ (
    at.querySelector("#insights-photo-viewer [data-photo-close]")
  ).click();
  await flush();
  assert.ok(
    document.activeElement === at.querySelector('[data-photo-open="a1"]'),
  );
});

test("a thumbnail that fails after its link ran out loads with a new link", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const read = vi
    .spyOn(adminApi, "recordPhotos")
    .mockResolvedValueOnce({ photos: [photo("first", NOW)], notes: [] })
    .mockResolvedValue({
      photos: [photo("second", NOW + 300_000)],
      notes: [],
    });
  const at = region();
  await show(at);
  vi.setSystemTime(NOW + 300_000);
  at.querySelector("img")?.dispatchEvent(new window.Event("error"));
  await flush();
  assert.equal(read.mock.calls.length, 2);
  assert.equal(at.querySelector("img")?.getAttribute("src"), "second-thumb");
  // A second failure on the new link is a broken photo, not a lapsed link.
  at.querySelector("img")?.dispatchEvent(new window.Event("error"));
  await flush();
  assert.equal(read.mock.calls.length, 2);
});

test("a photo link runs out by its own length, so a slow clock here still asks for a new one", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  // The server's clock is 5 minutes ahead, so its expiry time reads 10 minutes off here.
  const ahead = { ...photo("first", NOW + 300_000) };
  const read = vi
    .spyOn(adminApi, "recordPhotos")
    .mockResolvedValueOnce({ photos: [ahead], notes: [] })
    .mockResolvedValue({ photos: [photo("second", NOW)], notes: [] });
  const at = region();
  await show(at);
  vi.setSystemTime(NOW + 300_000);
  /** @type {HTMLElement} */ (at.querySelector("[data-photo-open]")).click();
  await flush();
  assert.equal(read.mock.calls.length, 2);
  assert.equal(
    at.querySelector("#insights-photo-viewer img")?.getAttribute("src"),
    "second",
  );
});

test("when a run-out link can't be renewed, the photo says so instead of opening a dead link", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(adminApi, "recordPhotos")
    .mockResolvedValueOnce({ photos: [photo("first", NOW)], notes: [] })
    .mockRejectedValue(new Error("reporting_failed"));
  const at = region();
  await show(at);
  vi.setSystemTime(NOW + 300_000);
  /** @type {HTMLElement} */ (at.querySelector("[data-photo-open]")).click();
  await flush();
  assert.equal(at.querySelector("#insights-photo-viewer") === null, true);
  assert.equal(
    at.querySelector('[role="alert"]')?.textContent,
    t("admin.insights.record.photoRenewFailed"),
  );
});
