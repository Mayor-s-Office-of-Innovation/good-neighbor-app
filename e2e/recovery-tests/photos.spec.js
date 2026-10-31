import { test, expect } from "@playwright/test";

test("failed photos reload the same URL after reconnect without rerendering", async ({
  page,
}) => {
  let available = false;
  let imageRequests = 0;
  await page.route("**/__photo_test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<html><body><script type="module">
    import {setSite} from '/src/db.js';
    import '/src/components/artifact-photo.js';
    await setSite('Example',{siteId:'example',deviceId:'synthetic-device',token:'synthetic-test-token'});
    document.body.insertAdjacentHTML('beforeend','<artifact-photo data-check-id="check" data-artifact-id="photo" style="display:block;width:100px;height:100px"><img></artifact-photo>');
  </script></body></html>`,
    }),
  );
  await page.route("**/v1/checks/check/artifacts/photo/media", (route) =>
    route.fulfill({
      json: {
        downloadUrl: "http://127.0.0.1:5182/synthetic-photo",
        expiresIn: 300,
      },
    }),
  );
  await page.route("**/synthetic-photo", (route) => {
    imageRequests++;
    return available
      ? route.fulfill({
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
        })
      : route.abort("internetdisconnected");
  });
  await page.goto("/__photo_test");
  await expect(page.locator("artifact-photo")).toHaveAttribute(
    "data-unavailable",
    "",
  );
  const before = imageRequests;
  await page.context().setOffline(true);
  available = true;
  await page.context().setOffline(false);
  await page.evaluate(() =>
    window.dispatchEvent(new window.Event("connectionretry")),
  );
  await expect(page.locator("artifact-photo img")).toHaveJSProperty(
    "naturalWidth",
    1,
  );
  expect(imageRequests).toBeGreaterThan(before);
});
