import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";

test("the deployed CSP permits the Home Screen sign-in handoff manifest", async ({
  page,
  context,
}) => {
  const terraform = await readFile(
    new URL("../../infra/modules/app/main.tf", import.meta.url),
    "utf8",
  );
  const policy = terraform
    .match(/content_security_policy = "([^"]+)"/)?.[1]
    .replace(/\$\{[^}]+\}/g, "uploads.example.test");
  if (!policy) throw new Error("Terraform frontend CSP is missing");
  const manifest = JSON.parse(
    await readFile(
      new URL("../../frontend/public/manifest.webmanifest", import.meta.url),
      "utf8",
    ),
  );
  const origin = "https://pwa.example.test";
  const startUrl = `${origin}/#handoff_grant=synthetic&handoff_token=synthetic`;
  /** @type {string[]} */
  const violations = [];
  page.on("console", (message) => {
    if (message.type() === "error") violations.push(message.text());
  });
  await page.route(`${origin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      headers: { "content-security-policy": policy },
      body: "<!doctype html><title>Handoff policy test</title>",
    }),
  );
  await page.goto(origin);
  // Like session-handoff.js, replace the static manifest with an absolute-URL
  // blob manifest. Use synthetic credentials; this test never contacts AWS.
  await page.evaluate(
    ({ manifest, origin, startUrl }) => {
      /** @param {string} path */
      const absolute = (path) => new URL(path, origin).href;
      const link = document.createElement("link");
      link.rel = "manifest";
      link.href = URL.createObjectURL(
        new window.Blob(
          [
            JSON.stringify({
              ...manifest,
              id: absolute(manifest.id),
              scope: absolute(manifest.scope),
              start_url: startUrl,
              icons: manifest.icons.map(
                (/** @type {{src: string}} */ icon) => ({
                  ...icon,
                  src: absolute(icon.src),
                }),
              ),
            }),
          ],
          { type: "application/manifest+json" },
        ),
      );
      document.head.append(link);
    },
    { manifest, origin, startUrl },
  );
  const cdp = await context.newCDPSession(page);
  const result = await cdp.send("Page.getAppManifest");
  if (!result.data) throw new Error("Browser rejected the handoff manifest");
  expect(JSON.parse(result.data).start_url).toBe(startUrl);
  expect(violations).toEqual([]);
});
