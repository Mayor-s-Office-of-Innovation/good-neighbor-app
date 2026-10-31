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
  await page.context().setOffline(true);
  await page.evaluate(() =>
    document.dispatchEvent(new window.Event("visibilitychange")),
  );
  await expect(page.locator("artifact-photo")).not.toHaveAttribute(
    "data-unavailable",
  );
  await expect(page.locator("artifact-photo img")).toBeVisible();
  await page
    .locator("artifact-photo")
    .evaluate((element) => (element.style.marginTop = "3000px"));
  await page.waitForTimeout(100);
  await page.locator("artifact-photo").scrollIntoViewIfNeeded();
  await expect(page.locator("artifact-photo img")).toBeVisible();
  await expect(page.locator("artifact-photo")).not.toHaveAttribute(
    "data-unavailable",
  );
});

test("to-do photos survive a guidance refresh while signing is in flight", async ({
  page,
}) => {
  let release = () => {};
  const signing = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  await page.route("**/__todo_photo_test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<html><body><main id="cards"></main><script type="module">
    import '/src/components/today-view.js';
    import '/src/components/artifact-photo.js';
    import {setSite} from '/src/db.js';
    import {taskAnalysisCard} from '/src/components/analysis-results.templates.js';
    await setSite('Synthetic',{siteId:'example',deviceId:'synthetic-device',token:'synthetic-test-token'});
    const task = {taskId:'task',checkId:'check',sourceArtifactIds:['photo'],status:'open',description:'Synthetic original'};
    const view = {_siteId:'example',_homeRefreshGeneration:1,_hydrationGeneration:0,isConnected:true,_homeFilter:'todo',_homeModel:{tasks:[task]},_homeTasks:tasks=>tasks.map(task=>({task,homeStatus:'needs_action'})),_renderHome:model=>{
      window.published=model;
      document.querySelector('#cards').innerHTML=model.tasks.map(task=>taskAnalysisCard({task,action:null})).join('');
    }};
    const pending=customElements.get('today-view').prototype._hydrateVisibleHomeTasks.call(view);
    view._homeModel={tasks:[{...task,description:'Synthetic edit',status:'in_progress'}],pendingGuidanceLoading:false};
    await pending;
    window.ready=true;
  </script></body></html>`,
    }),
  );
  await page.route("**/v1/checks/check", (route) =>
    route.fulfill({
      json: {
        artifacts: [
          {
            artifactId: "photo",
            s3Key: "synthetic",
            contentType: "image/jpeg",
          },
        ],
        analyses: [],
      },
    }),
  );
  await page.route(
    "**/v1/checks/check/artifacts/photo/media",
    async (route) => {
      await signing;
      await route.fulfill({
        json: {
          downloadUrl: "http://127.0.0.1:5182/todo-photo",
          expiresIn: 300,
        },
      });
    },
  );
  await page.route("**/todo-photo", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
    }),
  );
  const requested = page.waitForRequest(
    "**/v1/checks/check/artifacts/photo/media",
  );
  await page.goto("/__todo_photo_test");
  await requested;
  release();
  await page.waitForFunction(() => /** @type {any} */ (window).ready);
  await expect(page.locator("artifact-photo img")).toHaveJSProperty(
    "naturalWidth",
    1,
  );
  await expect(page.locator('wa-icon[name="file-lines"]')).toHaveCount(0);
  expect(
    await page.evaluate(() => ({
      status: /** @type {any} */ (window).published.tasks[0].status,
      description: /** @type {any} */ (window).published.tasks[0].description,
      loading: /** @type {any} */ (window).published.pendingGuidanceLoading,
    })),
  ).toEqual({
    status: "in_progress",
    description: "Synthetic edit",
    loading: false,
  });
});
