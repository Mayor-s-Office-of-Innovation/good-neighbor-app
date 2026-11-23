import { test, expect, mockAdmin } from "./admin-mock.js";
import { typeInto, openSite } from "./site-record-helpers.js";

test("details save sends the edited name and contact, then confirms", async ({
  page,
}) => {
  const api = await mockAdmin(page);
  await openSite(page);
  await typeInto(page, "site-name", "Example Site Renamed");
  await typeInto(page, "public-contact-email", "desk@example.org");
  await page.locator("[data-save-site-details]").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Example Site Renamed",
  );
  const [patch] = api.calls("PATCH", /^sites\/s1$/);
  expect(patch.body).toMatchObject({
    name: "Example Site Renamed",
    publicContact: { email: "desk@example.org", phone: "4155550100" },
    siteType: "shelter",
  });
});
