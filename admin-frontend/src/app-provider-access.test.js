import { test, vi } from "vitest";
import assert from "node:assert/strict";
import {
  $,
  $$,
  click,
  fill,
  mountPage,
  pageError,
  pageText,
  routeTo,
  settle,
  toastText,
  missing,
  window,
} from "../test-support/admin-dom.js";
import { gate } from "../../e2e/admin-tests/admin-mock.js";
import { providerData } from "../../e2e/admin-tests/providers-helpers.js";
import { t } from "../../frontend/src/i18n/i18n.js";
import "./pages/provider/provider-page.js";

const ACCESS = "/providers/v1?section=access";
const grants = /^providers\/v1\/manager-grants$/;

/** The Provider page's reads and its access writes; any other request fails a page test. */
const providerCalls = [
  /^GET providers\/[^/]+$/,
  /^GET providers\/[^/]+\/(manager-memberships|grants)$/,
  /^GET people$/,
  /^POST providers\/[^/]+\/manager-grants$/,
  /^DELETE providers\/[^/]+\/grants\/[^/]+$/,
  /^\w+ providers\/[^/]+\/manager-memberships\/[^/]+$/,
  /^POST providers\/[^/]+\/manager-enrollments\/[^/]+\/revoke$/,
];

/**
 * <admin-provider-page> alone, without <admin-app>, following the provider routes.
 * Its errors show through pageError(), as <admin-app>'s error line would show them.
 * @param {string} path
 * @param {Partial<Parameters<typeof mountPage>[2]>} [options]
 */
const openProviderPage = (path, options = {}) =>
  mountPage("admin-provider-page", path, {
    calls: providerCalls,
    follow: ["provider", "provider-new", "provider-manager"],
    recordErrors: true,
    data: providerData(),
    ...options,
  });

/** @param {string} mode */
const issueButton = (mode) =>
  `[data-issue-provider-manager-grant='m1'][data-delivery-mode='${mode}']`;
const title = () => $("#provider-title").textContent.trim();
const historyRows = () => $$("details tbody tr");

async function revokeAll() {
  await fill(
    "[data-revoke-provider-devices] wa-input[name='confirmation']",
    "Example Provider",
  );
  await click("[data-revoke-provider-devices] button[type='submit']");
}

/** @param {any} api */
async function openEmptyProvider(api) {
  api.on("GET", /^providers\/v2\/(manager-memberships|grants)$/, {
    json: { managers: [], enrollments: [], grants: [] },
  });
  await routeTo("/providers/v2?section=access");
  assert.equal(title(), "Second Provider");
}

function assertEmptyProvider() {
  assert.equal(title(), "Second Provider");
  assert.ok(pageText().includes(t("admin.providerManagers.none")));
  assert.equal(historyRows().length, 0);
  assert.ok(missing("[data-revoke-provider-enrollment]"));
  assert.equal(pageError(), "");
}

test("the access tab lists managers, invitations and enrolled devices", async () => {
  await openProviderPage(ACCESS);
  assert.ok($$("li").some((item) => item.textContent.includes("Alex")));
  const rows = historyRows();
  assert.equal(rows.length, 2);
  assert.ok(rows[0].querySelector("[data-copy-enrollment-url]"));
  assert.ok(rows[0].textContent.includes(t("admin.enrollment.magicLink")));
  assert.ok(rows[1].textContent.includes(t("admin.enrollment.oneTimeCode")));
  assert.match(rows[1].textContent, /queued/);
  assert.equal(
    rows[1].querySelector("[data-cancel-provider-manager-grant]"),
    null,
  );
  assert.equal($$("[data-revoke-provider-enrollment]").length, 2);
  assert.ok(
    $$("td").some((cell) => cell.textContent.trim() === "Provider Manager"),
  );
  assert.match(pageText(), /1 of 2 active/);
  assert.match(pageText(), /0 of 0 active/);
});

test("copying a provider enrollment link reports success", async () => {
  /** @type {string[]} */
  const copied = [];
  vi.spyOn(window.navigator.clipboard, "writeText").mockImplementation(
    async (text) => {
      copied.push(text);
    },
  );
  await openProviderPage(ACCESS);
  await click("[data-copy-enrollment-url]");
  assert.equal(
    $("[data-copy-enrollment-url]").getAttribute("aria-label"),
    "Enrollment link copied",
  );
  assert.equal(
    $("[data-copy-status]").textContent.trim(),
    "Enrollment link copied.",
  );
  assert.deepEqual(copied, ["https://example.org/enroll/g1"]);
});

test("an access tab with no managers or history shows empty states", async () => {
  const data = providerData();
  data.providerManagers = [];
  data.providerGrants = [];
  data.providerEnrollments = [];
  await openProviderPage(ACCESS, { data });
  const text = pageText();
  assert.ok(text.includes(t("admin.providerManagers.none")));
  assert.ok(text.includes(t("admin.enrollment.history", { count: 0 })));
  assert.ok(text.includes(t("admin.providerManagers.noDevices")));
});

for (const [mode, status, message] of [
  ["link", "accepted", "admin.enrollment.emailed"],
  ["code", "accepted", "admin.enrollment.codeEmailed"],
  ["link", "failed", "admin.toast.enrollmentEmailFailed"],
]) {
  test(`emailing a ${mode} invitation reports delivery ${status}`, async () => {
    const data = providerData();
    const { api } = await openProviderPage(ACCESS, {
      data,
      setup: (api) =>
        api.on("POST", grants, () => {
          data.providerGrants.unshift({
            grantId: "g9",
            providerId: "v1",
            issuedTo: "alex@example.org",
            deliveryMode: mode,
            status: "pending",
            deliveryStatus: status,
          });
          return {
            json: {
              grant: { grantId: "g9", deliveryStatus: status },
              enrollmentUrl: "https://example.org/enroll/g9",
            },
          };
        }),
    });
    await click(issueButton(mode));
    assert.ok(toastText().includes(t(message)));
    assert.ok(
      !missing("[data-copy-enrollment-url='https://example.org/enroll/g9']"),
    );
    assert.deepEqual(api.calls("POST", grants)[0].body, {
      membershipId: "m1",
      deliveryMode: mode,
    });
  });
}

test("an invitation that is already active is explained next to the manager", async () => {
  await openProviderPage(ACCESS, {
    setup: (api) =>
      api.fail("POST", grants, 409, "provider_manager_grant_already_active"),
  });
  await click(issueButton("link"));
  assert.equal(
    $("[data-provider-manager-grant-error='m1']").textContent.trim(),
    t("admin.enrollment.alreadyActive"),
  );
});

test("an already-active invitation error shows only beside its own manager", async () => {
  const data = providerData();
  data.providerManagers.push({
    ...data.providerManagers[0],
    membershipId: "m4",
    name: "Blair Second",
    email: "blair@example.org",
  });
  await openProviderPage(ACCESS, {
    data,
    setup: (api) =>
      api.fail("POST", grants, 409, "provider_manager_grant_already_active"),
  });
  await click(issueButton("link"));
  assert.equal($$("[data-provider-manager-grant-error]").length, 1);
  assert.ok(!missing("[data-provider-manager-grant-error='m1']"));
});

for (const code of [
  "provider_manager_grant_conflict",
  "manager_grant_conflict",
])
  test(`a ${code} invitation asks for a refresh`, async () => {
    await openProviderPage(ACCESS, {
      setup: (api) => api.fail("POST", grants, 409, code),
    });
    await click(issueButton("code"));
    assert.equal(pageError(), t("admin.enrollment.conflict"));
  });

test("other invitation failures show their error", async () => {
  await openProviderPage(ACCESS, {
    setup: (api) => api.fail("POST", grants, 500, "grant_store_down"),
  });
  await click(issueButton("link"));
  assert.equal(pageError(), t("admin.toast.requestFailed"));
});

test("an invitation whose refresh lands after leaving the provider is not redrawn", async () => {
  const held = gate();
  const { api } = await openProviderPage(ACCESS, {
    setup: (api) => {
      api.on("POST", grants, {
        json: { grant: { grantId: "g9", deliveryStatus: "accepted" } },
      });
      api.on("GET", /^providers\/v1\/manager-memberships$/, async () => {
        if (api.calls("POST", grants).length) await held.promise;
        return undefined;
      });
    },
  });
  await click(issueButton("link"));
  assert.ok(toastText().includes(t("admin.enrollment.emailed")));
  await openEmptyProvider(api);
  held.release();
  await settle();
  assertEmptyProvider();
});

test("cancelling a pending invitation refreshes the history", async () => {
  const data = providerData();
  await openProviderPage(ACCESS, {
    data,
    setup: (api) =>
      api.on("DELETE", /^providers\/v1\/grants\/g1$/, () => {
        data.providerGrants[0].status = "cancelled";
        return { json: {} };
      }),
  });
  await click("[data-cancel-provider-manager-grant='g1']");
  assert.ok(missing("[data-cancel-provider-manager-grant]"));
  assert.ok(toastText().includes(t("admin.toast.linkCancelled")));
});

test("a failed cancellation shows the error", async () => {
  await openProviderPage(ACCESS, {
    setup: (api) =>
      api.fail(
        "DELETE",
        /^providers\/v1\/grants\/g1$/,
        409,
        "provider_manager_grant_conflict",
      ),
  });
  await click("[data-cancel-provider-manager-grant='g1']");
  assert.equal(pageError(), t("admin.enrollment.conflict"));
});

test("revoking one enrolled device refreshes the device list", async () => {
  const data = providerData();
  await openProviderPage(ACCESS, {
    data,
    setup: (api) =>
      api.on("POST", /manager-enrollments\/e2\/revoke$/, () => {
        data.providerEnrollments[1].status = "revoked";
        return { json: {} };
      }),
  });
  await click("[data-revoke-provider-enrollment='e2']");
  assert.equal($$("[data-revoke-provider-enrollment]").length, 1);
  assert.ok(toastText().includes(t("admin.toast.accessRemoved")));
});

test("a failed device revocation shows the error", async () => {
  await openProviderPage(ACCESS, {
    setup: (api) =>
      api.fail(
        "POST",
        /manager-enrollments\/e2\/revoke$/,
        500,
        "revoke_failed",
      ),
  });
  await click("[data-revoke-provider-enrollment='e2']");
  assert.equal(pageError(), t("admin.toast.requestFailed"));
});

test("removing all provider access revokes every live device and skips ones already gone", async () => {
  const data = providerData();
  const { api } = await openProviderPage(ACCESS, {
    data,
    setup: (api) => {
      api.fail(
        "POST",
        /manager-enrollments\/e1\/revoke$/,
        404,
        "provider_manager_enrollment_not_found",
      );
      api.on("POST", /manager-enrollments\/e2\/revoke$/, () => {
        data.providerEnrollments = [];
        return { json: {} };
      });
    },
  });
  await revokeAll();
  assert.ok(pageText().includes(t("admin.providerManagers.noDevices")));
  assert.deepEqual(
    api.calls("POST", /revoke$/).map((call) => call.path),
    [
      "providers/v1/manager-enrollments/e1/revoke",
      "providers/v1/manager-enrollments/e2/revoke",
    ],
  );
  assert.deepEqual(api.calls("DELETE", /manager-memberships/), []);
});

test("a device revocation that fails part way stops and reports it", async () => {
  const { api } = await openProviderPage(ACCESS, {
    setup: (api) =>
      api.fail(
        "POST",
        /manager-enrollments\/e1\/revoke$/,
        500,
        "revoke_failed",
      ),
  });
  await revokeAll();
  assert.equal(
    $(
      "[data-revoke-provider-devices] [data-form-save-error]",
    ).textContent.trim(),
    t("admin.toast.requestFailed"),
  );
  assert.deepEqual(api.calls("POST", /e2\/revoke$/), []);
});

test("access refreshes that land after leaving the provider are dropped", async () => {
  const held = gate();
  const { api } = await openProviderPage(ACCESS, {
    setup: (api) => {
      api.on("DELETE", /^providers\/v1\/grants\/g1$/, { json: {} });
      api.on("GET", /^providers\/v1\/grants$/, async () => {
        if (api.calls("DELETE", /grants\/g1$/).length) await held.promise;
        return undefined;
      });
    },
  });
  await click("[data-cancel-provider-manager-grant='g1']");
  assert.ok(toastText().includes(t("admin.toast.linkCancelled")));
  await openEmptyProvider(api);
  held.release();
  await settle();
  assertEmptyProvider();
});

for (const { action, start, write, act } of [
  {
    action: "removing a manager",
    start: "/providers/v1",
    write: /manager-memberships\/m1$/,
    act: () => click("[data-provider-manager-status='m1']"),
  },
  {
    action: "revoking a device",
    start: ACCESS,
    write: /manager-enrollments\/e2\/revoke$/,
    act: () => click("[data-revoke-provider-enrollment='e2']"),
  },
  {
    action: "removing all access",
    start: ACCESS,
    write: /manager-enrollments\/e1\/revoke$/,
    act: revokeAll,
  },
]) {
  test(`${action} whose refresh lands after leaving the provider is dropped`, async () => {
    const held = gate();
    const { api } = await openProviderPage(start, {
      setup: (api) => {
        api.on("*", write, { json: {} });
        api.on("GET", /^providers\/v1\/grants$/, async () => {
          if (api.requests.some((request) => write.test(request.path)))
            await held.promise;
          return undefined;
        });
      },
    });
    await act();
    assert.equal(api.calls("GET", /^providers\/v1\/grants$/).length, 2);
    await openEmptyProvider(api);
    held.release();
    await settle();
    assertEmptyProvider();
  });
}

test("a provider whose access reads come back sparse still opens", async () => {
  await openProviderPage(ACCESS, {
    setup: (api) => {
      api.on("GET", /^providers\/v1$/, {
        json: { provider: { providerId: "v1", name: "Example Provider" } },
      });
      api.on("GET", /^providers\/v1\/(manager-memberships|grants)$/, {
        json: {},
      });
      api.on("GET", /^people$/, { json: {} });
    },
  });
  assert.equal(title(), "Example Provider");
  assert.ok(pageText().includes(t("admin.providerManagers.none")));
  assert.ok(pageText().includes(t("admin.enrollment.history", { count: 0 })));
});

test("sparse access replies after a revocation leave empty lists", async () => {
  await openProviderPage(ACCESS, {
    setup: (api) =>
      api.on("POST", /manager-enrollments\/e2\/revoke$/, () => {
        api.on("GET", /^providers\/v1\/(manager-memberships|grants)$/, {
          json: {},
        });
        return { json: {} };
      }),
  });
  await click("[data-revoke-provider-enrollment='e2']");
  assert.ok(pageText().includes(t("admin.providerManagers.noDevices")));
  assert.ok(pageText().includes(t("admin.providerManagers.none")));
});

for (const [label, reply, key] of [
  ["is shown", null, ""],
  [
    "already active is explained",
    { status: 409, json: { error: "provider_manager_grant_already_active" } },
    "admin.enrollment.alreadyActive",
  ],
])
  test(`a provider manager's one-time code ${label}`, async () => {
    const { api } = await openProviderPage(ACCESS, {
      setup: (api) =>
        api.on(
          "POST",
          grants,
          (/** @type {any} */ request) =>
            reply || {
              status: 201,
              json: {
                grant: {
                  grantId: "pg-screen",
                  membershipId: request.body.membershipId,
                  issuedTo: "alex@example.org",
                  status: "pending",
                  deliveryChannel: "screen",
                  createdAt: "2026-10-20T10:00:00Z",
                  expiresAt: "2099-01-01T00:00:00Z",
                },
                enrollmentCode: "135791",
              },
            },
        ),
    });
    await click(
      '[data-show-enrollment-code="m1"][data-enrollment-scope="provider"]',
    );
    assert.equal(api.calls("POST", grants)[0].body.membershipId, "m1");
    if (key) {
      assert.ok(toastText().includes(t(key)));
      assert.ok(missing("[data-enrollment-code]"));
    } else
      assert.match(
        $('[data-enrollment-code="pg-screen"]').textContent,
        /135791/,
      );
  });

/** @param {any} api */
function answerScreenGrant(api) {
  api.on("POST", grants, (/** @type {any} */ request) => ({
    status: 201,
    json: {
      grant: {
        grantId: "pg-screen",
        membershipId: request.body.membershipId,
        issuedTo: "alex@example.org",
        status: "pending",
        deliveryChannel: "screen",
        createdAt: "2026-10-20T10:00:00Z",
        expiresAt: "2099-01-01T00:00:00Z",
      },
      enrollmentCode: "135791",
    },
  }));
}

const showCode =
  '[data-show-enrollment-code="m1"][data-enrollment-scope="provider"]';

test("hiding the window clears a provider manager's one-time code", async () => {
  const { page } = await openProviderPage(ACCESS, { setup: answerScreenGrant });
  await click(showCode);
  assert.ok(!missing('[data-enrollment-code="pg-screen"]'));
  window.dispatchEvent(new window.Event("pagehide"));
  assert.ok(missing("[data-enrollment-code]"));
  page.render();
  assert.ok(missing("[data-enrollment-code]"));
});

test("leaving the provider removes its one-time code from the page", async () => {
  const { page } = await openProviderPage(ACCESS, { setup: answerScreenGrant });
  await click(showCode);
  page.leave();
  assert.ok(!page.querySelector("[data-enrollment-code]"));
  assert.ok(!page.innerHTML.includes("135791"));
});

test("a provider manager's one-time code is gone after leaving the tab", async () => {
  await openProviderPage(ACCESS, { setup: answerScreenGrant });
  await click(showCode);
  assert.ok(!missing('[data-enrollment-code="pg-screen"]'));
  await routeTo("/providers/v1?section=details");
  await routeTo(ACCESS);
  assert.ok(missing("[data-enrollment-code]"));
});
