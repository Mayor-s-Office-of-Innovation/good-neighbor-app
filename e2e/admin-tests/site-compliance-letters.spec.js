import { test, expect, mockAdmin } from "./admin-mock.js";
import { t } from "../helpers/i18n.js";
import {
  complianceData,
  compliancePath,
  letterEmail,
} from "./site-compliance-helpers.js";

const toasts = "app-toasts";
const letters = "[data-site-letters]";

/** A current letter that can be resent, plus past letters with and without files. */
const issuedLetters = {
  current: {
    url: "https://example.org/current.pdf",
    previewUrl: "https://example.org/current.png",
    fileName: "current.pdf",
    termsVersionId: "tv1",
  },
  past: [
    { url: "https://example.org/old.pdf", fileName: "old.pdf" },
    { createdAt: "2026-09-01T10:00:00Z" },
    {},
  ],
};

/**
 * Step the fake clock until a toast shows. Each poll waits on a network read
 * before it sets its next timer, so one long jump would fire only one poll.
 * @param {import("@playwright/test").Page} page
 * @param {string} text
 * @param {number} [step]
 */
async function advanceUntilToast(page, text, step = 1000) {
  await expect
    .poll(
      async () => {
        await page.clock.runFor(step);
        return (await page.locator(toasts).textContent()) || "";
      },
      // Short steps: a success toast closes itself after 3.5 fake seconds.
      { timeout: 30000, intervals: [50] },
    )
    .toContain(text);
}

/** @param {Record<string, any>} site @param {Record<string, any>} [extra] */
function meta(site, extra = {}) {
  return { ...site, sk: "#META", ...extra };
}

test("saving a requirement polls until the letter is generated and emailed", async ({
  page,
}) => {
  await page.clock.install();
  const data = complianceData();
  const api = await mockAdmin(page, { data });
  let statusReads = 0;
  api.on("POST", /^sites\/s1\/terms$/, (request) => {
    data.terms = [
      {
        siteId: "s1",
        effectiveStart: "2026-01-01",
        reasons: request.body.reasons,
        requiredChecksPerDay: request.body.requiredChecksPerDay,
        createdAt: "2026-01-01T10:00:00Z",
      },
    ];
    return { json: { jobId: "j1" } };
  });
  api.on("GET", /^sites\/s1\?view=status$/, () => {
    statusReads += 1;
    const site = meta(data.sites[0], {
      letterState: statusReads < 2 ? "draft_pending" : "ready",
    });
    return {
      json: { items: statusReads < 6 ? [site] : [site, letterEmail("j1")] },
    };
  });
  // The letter files appear only once generated, so seeing them proves the ready reload.
  api.on("GET", /^sites\/s1\?view=letters$/, () => ({
    json: {
      items: [
        meta(
          data.sites[0],
          statusReads >= 2 ? { complianceLetters: issuedLetters } : {},
        ),
        ...(statusReads >= 6 ? [letterEmail("j1")] : []),
      ],
    },
  }));
  await page.goto(compliancePath);
  await page.locator("[data-require-checks]").click();
  await page.locator("#new-checks-period-dialog [data-save-button]").click();
  await expect(page.getByText(t("admin.letters.pending"))).toBeVisible();
  expect(api.calls("POST", /^sites\/s1\/terms$/)[0].body).toMatchObject({
    reasons: ["3"],
    siteManagerUserId: "u1",
    requiredChecksPerDay: 3,
  });
  await expect(page.locator(letters)).toHaveAttribute("open", "");
  // The pending check's reload shows the generated files before the email poll sees a send.
  await expect
    .poll(
      async () => {
        await page.clock.runFor(500);
        return (await page.locator(letters).textContent()) || "";
      },
      { timeout: 30000, intervals: [50] },
    )
    .toContain("old.pdf");
  expect(statusReads).toBeLessThan(6);
  await advanceUntilToast(page, t("admin.letters.sent"));
  await expect(page.locator(letters).locator("tbody")).toContainText(
    "site@example.org",
  );
});
