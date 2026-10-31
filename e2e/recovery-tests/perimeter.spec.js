import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { t } from "../helpers/i18n.js";

const harness = `<!doctype html><html lang="en"><head><title>Perimeter recovery test</title></head>
<body><main id="view"><section><h1>Perimeter recovery</h1><button id="capture">Capture example photo</button><h2>Results</h2><div id="cards"></div></section></main>
<script type="module">
import '/src/styles/tokens.css'; import '/src/styles/base.css';
import * as state from '/src/state/check-session.js';
import {setSite,saveDraft} from '/src/db.js';
import {analyzeEvidenceItem,retryEvidenceItem} from '/src/services/photo-analysis.js';
import {startCheckSubmissionRecovery,resumeCheckSubmissions} from '/src/services/check-submissions.js';
import {analysisCards} from '/src/components/analysis-results.templates.js';
import {startHealthMonitoring} from '/src/services/backend-health.js';
await setSite('Example site',{siteId:'example',deviceId:'synthetic-device',token:'synthetic-test-token'});
await state.loadDraft('perimeter');
if(!state.getCurrentCheck()) state.startCheck('example');
const render=()=>{const check=state.getCurrentCheck(); document.querySelector('#cards').innerHTML=check.items.flatMap(item=>analysisCards(item,check.id)).join('');};
state.onCheckSessionChange(render); render();
document.querySelector('#capture').onclick=()=>{const item=state.addItem({kind:'photo',dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII='}); analyzeEvidenceItem(item.id);};
document.querySelector('#cards').onclick=(event)=>{const button=event.target.closest('[data-analysis-action="retry"]'); if(button&&retryEvidenceItem(button.closest('[data-item-id]').dataset.itemId)) button.disabled=true;};
/** @type {any} */ (window).recoveryTest={state,saveDraft,resumeCheckSubmissions}; startCheckSubmissionRecovery(); startHealthMonitoring(); /** @type {any} */ (window).ready=true;
</script></body></html>`;

/** @param {import("@playwright/test").Page} page */
async function setup(page) {
  const server = {
    interrupted: false,
    complete: false,
    uploads: 0,
    active: 0,
    peak: 0,
    artifacts: new Map(),
    reservations: new Map(),
    registrations: 0,
  };
  await page.route("**/__recovery_test", (route) =>
    route.fulfill({ contentType: "text/html", body: harness }),
  );
  // The real shell starts health monitoring. Its probes must stay inside this
  // synthetic backend too, rather than reaching a developer's local API.
  await page.route("**/health", (route) =>
    server.interrupted
      ? route.abort("internetdisconnected")
      : route.fulfill({ json: { ok: true } }),
  );
  await page.route("http://127.0.0.1:5182/", (route) =>
    server.interrupted
      ? route.abort("internetdisconnected")
      : route.fulfill({ status: 200, body: "" }),
  );
  await page.route("**/synthetic-upload/*", async (route) => {
    if (server.interrupted) return route.abort("internetdisconnected");
    server.active++;
    server.peak = Math.max(server.peak, server.active);
    await new Promise((resolve) => setTimeout(resolve, 100));
    server.uploads++;
    server.active--;
    await route.fulfill({ status: 200, body: "" });
  });
  await page.route("**/v1/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (server.interrupted) return route.abort("internetdisconnected");
    if (path.endsWith("artifacts:presign")) {
      const body = request.postDataJSON();
      if (!server.reservations.has(body.uploadRequestId))
        server.reservations.set(
          body.uploadRequestId,
          `artifact-${server.reservations.size + 1}`,
        );
      const artifactId = server.reservations.get(body.uploadRequestId);
      return route.fulfill({
        json: {
          artifactId,
          s3Key: `synthetic/${artifactId}`,
          uploadUrl: `http://127.0.0.1:5182/synthetic-upload/${artifactId}`,
          uploadHeaders: {},
        },
      });
    }
    if (path.endsWith("/artifacts")) {
      const body = request.postDataJSON();
      server.artifacts.set(body.artifactId, body);
      server.registrations++;
      return route.fulfill({
        status: 202,
        json: { artifactId: body.artifactId, status: "queued" },
      });
    }
    if (path === "/v1/assessments:evaluate")
      return route.fulfill({
        json: { assessment: {}, conditions: [], tasks: [] },
      });
    if (request.method() === "GET" && path.startsWith("/v1/checks/"))
      return route.fulfill({
        json: {
          check: {},
          artifacts: [...server.artifacts.values()],
          analyses: [...server.artifacts.keys()]
            .filter((id, index) => server.complete || index === 0)
            .map((artifactId) => ({
              artifactId,
              status: "analyzed",
              concerns: [],
            })),
        },
      });
    return route.fulfill({ json: {} });
  });
  await page.goto("/__recovery_test");
  await page.waitForFunction(() => /** @type {any} */ (window).ready);
  return server;
}

/** @param {import("@playwright/test").Page} page */
async function statuses(page) {
  return page.evaluate(() =>
    /** @type {any} */ (window).recoveryTest.state
      .getCurrentCheck()
      .items.map((/** @type {any} */ item) => item.analysis.status),
  );
}

test("Wi-Fi to shaky cellular to offline recovers photos without manual retries", async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  const server = await setup(page);
  for (let i = 0; i < 4; i++) await page.locator("#capture").click();
  await expect.poll(() => statuses(page)).toContain("analyzed");
  server.interrupted = true;
  for (let i = 0; i < 2; i++) await page.locator("#capture").click();
  await expect
    .poll(
      async () =>
        (await statuses(page)).filter(
          (/** @type {string} */ status) => status === "waiting",
        ).length,
    )
    .toBeGreaterThan(0);
  await expect(page.locator('[data-analysis-action="retry"]')).toHaveCount(0);
  server.interrupted = false;
  server.complete = true;
  // Recovery is driven by the real health probe and connectionretry event;
  // no manual retry or direct queue invocation announces reconnection here.
  await expect
    .poll(() => statuses(page), { timeout: 75_000 })
    .toEqual(Array(6).fill("analyzed"));
  expect(server.uploads).toBe(6);
  expect(server.peak).toBeLessThanOrEqual(2);
  await context.setOffline(true);
  await page.locator("#capture").click();
  await expect(page.locator("#cards")).toContainText(t("notice.savedOnPhone"));
  await expect(page.locator('[data-analysis-action="retry"]')).toHaveCount(0);
  await context.setOffline(false);
  await page.evaluate(() =>
    /** @type {any} */ (window).recoveryTest.resumeCheckSubmissions(),
  );
  await expect.poll(() => statuses(page)).toEqual(Array(7).fill("analyzed"));
  expect(server.uploads).toBe(7);
  expect(server.registrations).toBe(7);
});

test("an exhausted retry survives reload and offline waiting, then repeated activation starts one upload", async ({
  page,
  context,
}) => {
  const server = await setup(page);
  server.complete = true;
  await page.evaluate(async () => {
    const { state, saveDraft } = /** @type {any} */ (window).recoveryTest;
    const item = state.addItem({
      kind: "photo",
      dataUrl: "data:image/png;base64,AA==",
    });
    state.updateItemAnalysis(item.id, {
      status: "failed",
      localSaveConfirmed: true,
      recovery: { stage: "upload", state: "manual", attempts: 3 },
      failure: { leg: "upload" },
    });
    await saveDraft(state.getCurrentCheck());
  });
  await page.reload();
  await page.waitForFunction(() => /** @type {any} */ (window).ready);
  await expect(page.locator('[data-analysis-action="retry"]')).toBeEnabled();
  expect(server.uploads).toBe(0);
  await page.screenshot({
    path: `/tmp/gnp-recovery-${test.info().project.name}-manual.png`,
  });
  await context.setOffline(true);
  await page.evaluate(() =>
    /** @type {any} */ (window).recoveryTest.state.updateItemAnalysis(
      /** @type {any} */ (window).recoveryTest.state.getCurrentCheck().items[0]
        .id,
      {},
    ),
  );
  await expect(page.locator('[data-analysis-action="retry"]')).toHaveCount(0);
  await context.setOffline(false);
  await page.evaluate(() =>
    /** @type {any} */ (window).recoveryTest.state.updateItemAnalysis(
      /** @type {any} */ (window).recoveryTest.state.getCurrentCheck().items[0]
        .id,
      {},
    ),
  );
  const retry = page.locator('[data-analysis-action="retry"]');
  await retry.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect.poll(() => statuses(page)).toEqual(["analyzed"]);
  expect(server.uploads).toBe(1);
  expect(
    (await new AxeBuilder({ page }).include("#view").analyze()).violations,
  ).toEqual([]);
});

test("finishing queued device writes cannot erase the next capture or resurrect its old draft", async ({
  page,
}) => {
  await setup(page);
  const result = await page.evaluate(async () => {
    const { state } = /** @type {any} */ (window).recoveryTest;
    const modulePath = "/src/db.js";
    const db = await import(modulePath);
    const previous = state.getCurrentCheck();
    for (let i = 0; i < 8; i++)
      state.addItem({ kind: "text", text: "Synthetic capture evidence" });
    state.markCaptureComplete({ expectedArtifacts: 8 });
    const next = state.startCheck("example");
    await db.saveDraft(next);
    // Let the queued scoped draft clear finish as well.
    await db.clearDraft({
      flowType: "perimeter",
      siteId: "example",
      checkId: previous.id,
    });
    const draft = await db.getDraft("perimeter");
    const finished = await db.listFinishedChecks("example");
    return {
      expected: next.id,
      draft: draft.id,
      finished: finished.find(
        (/** @type {any} */ check) => check.id === previous.id,
      )?.items.length,
    };
  });
  expect(result.draft).toBe(result.expected);
  expect(result.finished).toBe(8);
});
