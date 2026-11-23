import { test, expect, mockAdmin, adminData } from "./admin-mock.js";
import { openSite } from "./site-record-helpers.js";
import { compliancePath } from "./site-compliance-helpers.js";

function perimeterData() {
  const data = adminData();
  data.sites[0] = {
    ...data.sites[0],
    perimeter: "16th Street between #1456 and #1756",
    perimeterUpdatedAt: "2026-10-18T10:00:00Z",
  };
  return data;
}

/** @param {import("@playwright/test").Page} page */
const form = (page) => page.locator("#site-perimeter-form");
/** @param {import("@playwright/test").Page} page */
const textarea = (page) =>
  page.locator('#site-perimeter-form wa-textarea[name="perimeter"] textarea');

test("perimeter save sends the text with the record version", async ({
  page,
}) => {
  const api = await mockAdmin(page, { data: perimeterData() });
  api.on("PUT", /^sites\/s1\/perimeter$/, (request) => ({
    json: {
      perimeter: request.body.perimeter,
      updatedAt: "2026-10-30T10:00:00Z",
      perimeterUpdatedAt: "2026-10-30T10:00:00Z",
      perimeterUpdatedBy: "dana@example.org",
      perimeterUpdatedSource: "dashboard",
      perimeterUpdatedDeviceLabel: "",
    },
  }));
  await openSite(page, compliancePath);
  await textarea(page).fill("Mission Street from 16th to 17th");
  await form(page).locator("[data-save-button]").click();
  await expect(page.locator("#site-perimeter-form + p")).toContainText(
    "dana@example.org",
  );
  expect(api.calls("PUT", /^sites\/s1\/perimeter$/)[0].body).toEqual({
    perimeter: "Mission Street from 16th to 17th",
    expectedUpdatedAt: "2026-10-20T10:00:00Z",
  });
});
