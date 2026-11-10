import { test } from "vitest";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import {
  $,
  adminData,
  fakePage,
  globToRegExp,
  mountAdmin,
  settle,
  teardown,
  tick,
  toastCount,
  toastText,
  unhandledRejection,
  window,
} from "./admin-dom.js";
import { quietInspect } from "./quiet-inspect.js";
import { gate } from "../../e2e/admin-tests/admin-mock.js";
import { getToasts, showToast } from "../../frontend/src/state/toasts.js";

test("toastText returns when a toast won't close", async () => {
  await mountAdmin("/sites");
  const stuck = showToast({ title: "Stuck", message: "Never closes" });
  const close = stuck.close;
  stuck.close = () => {};
  assert.equal(toastText(), "Stuck Never closes");
  assert.equal(getToasts()[0], stuck);
  close();
});

test("toastText reads at most 20 queued toasts per call", async () => {
  await mountAdmin("/sites");
  for (let index = 1; index <= 25; index++)
    showToast({ title: `Toast ${index}`, message: "" });
  const shown = toastText().split(" Toast ").length;
  // 20 closed, plus Toast 21, which is now on screen.
  assert.equal(shown, 21);
  assert.equal(getToasts()[0].title, "Toast 21");
});

test("toastCount counts a toast that timed out before it was read", async () => {
  await mountAdmin("/sites");
  showToast({ title: "Sent", message: "" });
  await tick(4000);
  showToast({ title: "Sent", message: "" });
  await tick(4000);
  assert.equal(toastCount("Sent"), 2);
});

test("toastText includes a toast that timed out before it was read", async () => {
  await mountAdmin("/sites");
  showToast({ title: "Saved", message: "" });
  await tick(4000);
  assert.equal(toastText(), "Saved");
});

test("the fake backend won't remove another Site's manager membership", async () => {
  const data = adminData();
  data.memberships.push({
    membershipId: "m1",
    siteId: "s1",
    type: "managerMembership",
    status: "active",
  });
  const { api } = await mountAdmin("/sites", { data });
  const remove = (/** @type {string} */ siteId) =>
    api.reply({
      method: "DELETE",
      path: `sites/${siteId}/manager-memberships/m1`,
      search: "",
      body: undefined,
      headers: {},
    });
  assert.equal(remove("s2").status, 404);
  assert.equal(data.memberships[0].status, "active");
  assert.equal(remove("s1").json.deactivated, true);
});

test("the fake backend lists only the asked Site's grants and devices", async () => {
  const data = adminData();
  data.grants.push({ siteId: "s1", grantId: "g1", status: "pending" });
  data.devices.push({ siteId: "s1", bindingId: "b1", status: "active" });
  const { api } = await mountAdmin("/sites", { data });
  const list = (/** @type {string} */ path) =>
    api.reply({ method: "GET", path, search: "", body: undefined, headers: {} })
      .json;
  assert.deepEqual(list("sites/s2/grants"), { grants: [] });
  assert.deepEqual(list("sites/s2/devices"), { devices: [] });
  assert.equal(list("sites/s1/grants").grants[0].grantId, "g1");
  assert.equal(list("sites/s1/devices").devices[0].bindingId, "b1");
});

test("the fake backend lists only the asked Site's terms and provider's managers", async () => {
  const data = adminData();
  data.terms.push({ siteId: "s2", effectiveStart: "2026-09-01" });
  data.providerManagers.push({ providerId: "v1", membershipId: "m1" });
  data.providerEnrollments.push({ providerId: "v1", enrollmentId: "e1" });
  data.providerGrants.push({ providerId: "v1", grantId: "g1" });
  const { api } = await mountAdmin("/sites", { data });
  const list = (/** @type {string} */ path) =>
    api.reply({ method: "GET", path, search: "", body: undefined, headers: {} })
      .json;
  assert.deepEqual(
    list("sites/s2/terms").terms.map((/** @type {any} */ term) => term.siteId),
    ["s2"],
  );
  assert.deepEqual(list("providers/v2/grants"), { grants: [] });
  assert.deepEqual(list("providers/v2/manager-memberships"), {
    managers: [],
    enrollments: [],
  });
  assert.equal(list("providers/v1/grants").grants[0].grantId, "g1");
  assert.equal(
    list("providers/v1/manager-memberships").enrollments[0].enrollmentId,
    "e1",
  );
});

test("a status-only reply has an empty body and no content type, as in Playwright", async () => {
  await mountAdmin("/sites");
  for (const status of [202, 204])
    await fakePage.route(`**/status-${status}`, (route) =>
      route.fulfill({ status }),
    );
  for (const status of [202, 204]) {
    const response = await fetch(`http://localhost/status-${status}`);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("content-type"), null);
    assert.equal(await response.text(), "");
  }
});

test("unhandledRejection fails on a second rejection in the same action", async () => {
  await mountAdmin("/sites");
  const reject = (/** @type {string} */ message) =>
    Promise.reject(new Error(message));
  const one = await unhandledRejection(async () => {
    reject("known");
  });
  assert.equal(one.message, "known");
  await assert.rejects(
    unhandledRejection(async () => {
      reject("known");
      reject("new bug");
    }),
    /known; new bug/,
  );
});

test("a remount doesn't join the old mount's held read", async () => {
  const held = gate();
  await mountAdmin("/sites", {
    setup: (api) =>
      api.on("GET", /^session$/, async () => {
        await held.promise;
        return undefined;
      }),
  });
  await mountAdmin("/sites");
  assert.ok(
    window.document
      .querySelector("admin-app")
      ?.textContent?.includes("Example Site"),
  );
});

test("quietInspect can run again on a window whose prototypes it already changed", async () => {
  await mountAdmin("/sites");
  assert.doesNotThrow(() => quietInspect(window));
  assert.equal(inspect($("admin-app")), "<admin-app>");
});

test("a route glob follows Playwright's rules for **/, /**/, {a,b}, backslash and ?", () => {
  const admin = globToRegExp("**/admin/v1/**");
  assert.ok(admin.test("http://localhost/admin/v1/sites/s1?x=1"));
  assert.ok(!admin.test("http://localhost/config.js"));
  // A leading **/ needs its slash.
  assert.ok(!admin.test("admin/v1/sites"));
  // /**/ may match a single slash.
  const deep = globToRegExp("http://localhost/**/main.js");
  assert.ok(deep.test("http://localhost/main.js"));
  assert.ok(deep.test("http://localhost/src/app/main.js"));
  const group = globToRegExp("**/*.{png,jpg}");
  assert.ok(group.test("http://localhost/a.png"));
  assert.ok(group.test("http://localhost/a.jpg"));
  assert.ok(!group.test("http://localhost/a.gif"));
  const escaped = globToRegExp("**/a\\*b");
  assert.ok(escaped.test("http://localhost/a*b"));
  assert.ok(!escaped.test("http://localhost/axb"));
  const one = globToRegExp("http://localhost/*.js?v=1");
  assert.ok(one.test("http://localhost/config.js?v=1"));
  assert.ok(!one.test("http://localhost/config.jsXv=1"));
  assert.ok(!one.test("http://localhost/src/main.js?v=1"));
  assert.throws(() => globToRegExp("**/{a,b"), /Unmatched/);
});

test("settle throws when fetches never stop", async () => {
  await mountAdmin("/sites", {
    fetch: (url) => (url.endsWith("/spin") ? new Response("{}") : undefined),
  });
  let spinning = true;
  const spin = async () => {
    // One fetch per task turn, as a polling loop would; a microtask loop would starve settle().
    while (spinning) {
      await new Promise((resolve) => setImmediate(resolve));
      await fetch("http://localhost/spin");
    }
  };
  const loop = spin();
  await assert.rejects(settle(), /400 turns/);
  spinning = false;
  await loop;
});

test("teardown still reports a route gap when settle() stalls", async () => {
  await mountAdmin("/sites", {
    fetch: (url) => (url.endsWith("/spin") ? new Response("{}") : undefined),
  });
  await fetch("http://localhost/no-route");
  // Polls until teardown removes <admin-app>, so settle() never sees a quiet turn.
  const spin = async () => {
    for (;;) {
      await new Promise((resolve) => setImmediate(resolve));
      if (!window.document.querySelector("admin-app")) return;
      await fetch("http://localhost/spin");
    }
  };
  const loop = spin();
  await assert.rejects(
    teardown(),
    /400 turns.*GET http:\/\/localhost\/no-route/,
  );
  await loop;
});

test("a form reset restores each option's markup selection", async () => {
  await mountAdmin("/sites");
  const form = window.document.createElement("form");
  form.innerHTML =
    '<wa-select name="pick"><wa-option value="a" selected></wa-option><wa-option value="b"></wa-option></wa-select>';
  window.document.body.append(form);
  const select = /** @type {any} */ (form.querySelector("wa-select"));
  select.value = "b";
  form.reset();
  assert.equal(select.value, "a");
  form.remove();
});
