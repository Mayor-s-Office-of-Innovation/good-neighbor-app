import { test, expect } from "@playwright/test";
import { bindSite } from "../helpers/app.js";

test("site binding starts with a fresh code-attempt budget after other contexts exhaust it", async ({
  page,
}) => {
  // The real local API reports every browser as 127.0.0.1. Leave the source
  // budget exhausted, as earlier tests in a fast full-suite run can do.
  let blocked;
  // Allow one fixed-window boundary while filling the budget. Stop on the
  // first rejection so a subsequent boundary cannot hide the reproduction.
  for (let attempt = 0; attempt < 201; attempt++) {
    blocked = await page.request.post("/site-code", {
      data: { code: "ZZZZZZ" },
    });
    if (blocked.status() === 429) break;
    expect(blocked.status()).toBe(401);
  }
  if (!blocked) throw new Error("No login attempt was sent");
  expect(blocked.status()).toBe(429);
  expect(await blocked.json()).toEqual({ error: "code_attempts_limited" });

  await bindSite(page);
  await expect(page.locator("#start-check")).toBeVisible();
});
