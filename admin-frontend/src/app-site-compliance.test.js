import { beforeEach, describe, test, vi } from "vitest";
import assert from "node:assert/strict";
import {
  $,
  $$,
  click,
  fill,
  missing,
  pageError,
  routeTo,
  settle,
  tick,
  toastCount,
  toastText,
  window,
} from "../test-support/admin-dom.js";
import { mountAdmin } from "../test-support/app-mount.js";
import { gate } from "../../e2e/admin-tests/admin-mock.js";
import {
  complianceData,
  compliancePath,
  letterEmail,
} from "../../e2e/admin-tests/site-compliance-helpers.js";
import { t } from "../../frontend/src/i18n/i18n.js";

// pages/site/compliance.templates.js and save-error-messages.js have no catalog key for this copy, so tests match their English.

describe("Site compliance", () => {
  // A fixed date, so fixture dates such as the 2026-12-31 terms expiry stay in the future.
  beforeEach(() => {
    vi.useFakeTimers({ now: Date.parse("2026-10-15T12:00:00Z") });
  });

  const dialog = "#new-checks-period-dialog";
  const save = `${dialog} [data-save-button]`;
  const saveError = `${dialog} [data-form-save-error]`;
  const letters = "[data-site-letters]";
  const reason = (/** @type {string} */ value) =>
    `wa-checkbox[name='terms-reason'][value='${value}']`;
  const url = () => window.location.pathname + window.location.search;
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
  const UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  /** @param {any} site @param {object} [extra] */
  const meta = (site, extra = {}) => ({ ...site, sk: "#META", ...extra });

  /** @param {any} data @param {(api: any) => void} [setup] @param {any} [role] */
  const openCompliance = (data, setup, role) =>
    mountAdmin(compliancePath, { data, setup, role });

  /** Advance the fake clock until a toast with `text` has shown. @param {string} text */
  async function untilToast(text, step = 1000) {
    for (let turn = 0; turn < 90 && !toastText().includes(text); turn++)
      await tick(step);
    assert.match(toastText(), new RegExp(text));
  }

  async function openLetters() {
    $(`${letters} summary`).click();
    await settle();
  }

  /** @param {string} value */
  async function choose(value) {
    await click(`#end-checks-period-dialog [value="${value}"]`);
  }

  async function refuseForMissingContact() {
    await click("[data-require-checks]");
    await fill(reason("1"), true);
    await fill("wa-input[name='terms-expiry']", "2026-12-31");
    await fill("wa-number-input[name='terms-checks-per-day']", "4");
    await click(save);
  }

  test("the requirement dialog checks reasons, end date and cadence before saving", async () => {
    const { api } = await openCompliance(complianceData());
    await click("[data-require-checks]");
    assert.equal($(dialog).open, true);
    assert.equal($(save).disabled, false);
    await fill(reason("3"), false);
    assert.equal($(save).disabled, true);
    await fill(reason("1"), true);
    assert.equal($("[data-expiry-field]").hidden, false);
    assert.equal($(save).disabled, true);
    await fill("wa-input[name='terms-expiry']", "2026-12-31");
    assert.equal($(save).disabled, false);
    await fill("wa-number-input[name='terms-checks-per-day']", "9");
    assert.equal($(save).disabled, true);
    await fill("wa-number-input[name='terms-checks-per-day']", "2");
    assert.equal($(save).disabled, false);
    await click("[data-cancel-checks-period]");
    assert.equal($(dialog).open, false);
    assert.equal(api.calls("POST", /terms/).length, 0);
  });

  test("the cadence accepts 1 to 8 whole checks a day", async () => {
    await openCompliance(complianceData());
    await click("[data-require-checks]");
    for (const [cadence, valid] of [
      ["1", true],
      ["8", true],
      ["0", false],
      ["2.5", false],
      ["9", false],
    ]) {
      await fill("wa-number-input[name='terms-checks-per-day']", cadence);
      assert.equal($(save).disabled, !valid, cadence);
    }
  });

  test("a read-only Site keeps reason explanations but not requirement actions", async () => {
    await openCompliance(
      complianceData({ active: true }),
      (api) =>
        api.on("GET", /^sites\/s1\?view=compliance$/, () => ({
          json: {
            items: [meta(api.data.sites[0]), ...api.data.siteItems.s1],
            permissions: { canEdit: false },
          },
        })),
      "compliance-manager",
    );
    assert.equal($("[data-end-checks]").disabled, true);
    await click("[data-compliance-reason='3']");
    assert.equal($("#compliance-reasons-dialog").open, true);
  });

  test("a read-only Site without a requirement cannot start one", async () => {
    await openCompliance(
      complianceData(),
      (api) =>
        api.on("GET", /^sites\/s1\?view=compliance$/, () => ({
          json: {
            items: [meta(api.data.sites[0]), ...api.data.siteItems.s1],
            permissions: { canEdit: false },
          },
        })),
      "compliance-manager",
    );
    assert.equal($("[data-require-checks]").disabled, true);
  });

  test("a failed requirement save explains each API refusal", async () => {
    const { api } = await openCompliance(complianceData());
    await click("[data-require-checks]");
    for (const [code, message] of [
      [
        "generator_department_required",
        t("admin.compliance.generatorDepartmentRequired"),
      ],
      ["expiry_required", "Enter the last day checks are required"],
      ["letter_details_required", "Complete the Site manager, address"],
      ["terms_overlap", "overlaps another period"],
      ["internal_error", "couldn't be saved. Try again."],
      ["terms_start_conflict", "overlaps another period"],
    ]) {
      api.fail("POST", /^sites\/s1\/terms$/, 409, code);
      await click(save);
      assert.ok($(saveError).textContent.includes(message), code);
      assert.equal($(save).textContent.trim(), t("admin.letters.saveSend"));
      assert.equal($(save).disabled, false);
    }
  });

  test("a missing generator contact links to the profile", async () => {
    await openCompliance(complianceData(), (api) =>
      api.fail("POST", /^sites\/s1\/terms$/, 400, "generator_contact_required"),
    );
    await click("[data-require-checks]");
    await click(save);
    assert.equal(
      $(`${saveError} a`).textContent.trim(),
      t("admin.profile.title"),
    );
  });

  test("ending the requirement asks first and reloads the Site", async () => {
    const data = complianceData({ active: true });
    const { api } = await openCompliance(data, (api) =>
      api.on("POST", /^sites\/s1\/terms:close$/, () => {
        data.terms = data.terms.slice(1);
        return { json: {} };
      }),
    );
    await click("[data-end-checks]");
    assert.equal($("#end-checks-period-dialog").open, true);
    await choose("cancel");
    assert.equal(api.calls("POST", /terms:close/).length, 0);
    await click("[data-end-checks]");
    await choose("confirm");
    assert.match(toastText(), new RegExp(t("admin.toast.requirementEnded")));
    assert.ok(missing("[data-end-checks]"));
    assert.ok(!missing("[data-require-checks]"));
    assert.equal($("[data-site-terms]").open, true);
  });

  test("a failed end keeps the requirement and shows the error", async () => {
    await openCompliance(complianceData({ active: true }), (api) =>
      api.fail("POST", /^sites\/s1\/terms:close$/, 500, "close_failed"),
    );
    await click("[data-end-checks]");
    await choose("confirm");
    // Pins a bug: the raw API code shows instead of a message. No issue filed yet.
    assert.equal(pageError(), "close_failed");
    assert.ok(!missing("[data-end-checks]"));
  });

  test("period history lists past periods", async () => {
    await openCompliance(complianceData({ active: true }));
    const history = $("[data-site-terms]");
    for (const shown of [
      "Legacy period",
      t("admin.compliance.yes"),
      "2025-09-30",
      "Until further notice",
    ])
      assert.ok(history.textContent.includes(shown), shown);
  });

  test("a reason number opens its explanation until the user clicks outside", async () => {
    await openCompliance(complianceData({ active: true }));
    const reasons = $("#compliance-reasons-dialog");
    await click("[data-compliance-reason='3']");
    assert.equal(reasons.open, true);
    // The same point as the click below, so only the target (the dialog's h2)
    // keeps the dialog open.
    for (const type of ["pointerdown", "click"])
      reasons.querySelector("h2").dispatchEvent(
        new window.MouseEvent(type, {
          bubbles: true,
          clientX: 5,
          clientY: 5,
        }),
      );
    assert.equal(reasons.open, true);
    // The dialog has no layout here, so any point lies outside its box.
    for (const type of ["pointerdown", "click"])
      reasons.dispatchEvent(
        new window.MouseEvent(type, { bubbles: true, clientX: 5, clientY: 5 }),
      );
    assert.equal(reasons.open, false);
  });

  test("a Site missing letter details cannot require checks", async () => {
    const data = complianceData();
    data.sites[0].siteType = "permanent_supportive_housing";
    data.sites[0].oversight = {};
    data.siteItems.s1.push({
      sk: "ASSIGNED_USER#u2",
      type: "siteUserAssignment",
      userId: "u2",
      status: "active",
    });
    await openCompliance(data);
    assert.equal($("[data-require-checks]").disabled, true);
    assert.ok(!missing("#perimeter-checks-prerequisite-error"));
    assert.ok($(reason("2")).hasAttribute("checked"));
  });

  for (const [siteType, expected] of [
    ["other", []],
    ["shelter", ["3"]],
    ["drop_in", ["4"]],
    ["permanent_supportive_housing", ["2"]],
  ]) {
    test(`a new requirement for a ${siteType} Site preselects reasons [${expected}]`, async () => {
      const data = complianceData();
      data.sites[0].siteType = siteType;
      await openCompliance(data);
      assert.deepEqual(
        $$(`${dialog} wa-checkbox[name='terms-reason']`)
          .filter((box) => box.checked)
          .map((box) => box.value),
        expected,
      );
    });
  }

  test("completing the profile returns to the requirement with its draft", async () => {
    const data = complianceData();
    data.profile = { ...data.profile, phone: "" };
    await openCompliance(data, (api) =>
      api.fail("POST", /^sites\/s1\/terms$/, 400, "generator_contact_required"),
    );
    await refuseForMissingContact();
    await click(`${saveError} a`);
    assert.ok(!missing("#my-profile-form"));
    await fill("#my-profile-form wa-input[name='phone']", "4155550123");
    await click("#my-profile-form [data-save-button]");
    await tick(16);
    assert.match(url(), /section=compliance/);
    assert.equal($(dialog).open, true);
    assert.equal($(reason("1")).checked, true);
    assert.equal($("wa-input[name='terms-expiry']").value, "2026-12-31");
    assert.equal($("wa-number-input[name='terms-checks-per-day']").value, "4");
  });

  test("a failed return keeps the draft until the retry succeeds", async () => {
    const data = complianceData();
    const { api } = await openCompliance(data, (api) =>
      api.fail("POST", /^sites\/s1\/terms$/, 400, "generator_contact_required"),
    );
    await refuseForMissingContact();
    await click(`${saveError} a`);
    assert.ok(!missing("#profile-title"));
    api.fail("GET", /^sites\/s1\?view=compliance$/, 503, "site_unavailable");
    await routeTo(compliancePath);
    assert.equal(
      $("#retry-compliance-draft").textContent.trim(),
      t("admin.compliance.resumeDraft"),
    );
    api.on("GET", /^sites\/s1\?view=compliance$/, () => ({
      json: {
        items: [meta(data.sites[0]), ...data.siteItems.s1],
        permissions: { canEdit: true },
      },
    }));
    await click("#retry-compliance-draft");
    await tick(16);
    assert.equal($(dialog).open, true);
    assert.equal($(reason("1")).checked, true);
  });

  test("leaving the profile for another page drops the draft", async () => {
    await openCompliance(complianceData(), (api) =>
      api.fail("POST", /^sites\/s1\/terms$/, 400, "generator_contact_required"),
    );
    await refuseForMissingContact();
    await click(`${saveError} a`);
    await routeTo("/sites");
    await routeTo(compliancePath);
    await tick(16);
    assert.ok(!missing("#compliance-title"));
    assert.equal($(dialog).open, false);
  });

  test("saving a requirement polls until the letter is generated and emailed", async () => {
    const data = complianceData();
    let statusReads = 0;
    const { api } = await openCompliance(data, (api) => {
      api.on("POST", /^sites\/s1\/terms$/, (/** @type {any} */ request) => {
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
    });
    await click("[data-require-checks]");
    await click(save);
    assert.ok($("admin-app").textContent.includes(t("admin.letters.pending")));
    const { body } = api.calls("POST", /^sites\/s1\/terms$/)[0];
    assert.deepEqual(
      [body.reasons, body.siteManagerUserId, body.requiredChecksPerDay],
      [["3"], "u1", 3],
    );
    assert.equal($(letters).open, true);
    for (
      let turn = 0;
      turn < 20 && !$(letters).textContent.includes("old.pdf");
      turn++
    )
      await tick(500);
    assert.ok($(letters).textContent.includes("Previous letter"));
    assert.ok(statusReads < 6);
    await untilToast(t("admin.letters.sent"));
    assert.ok($(`${letters} tbody`).textContent.includes("site@example.org"));
    // Polling stops once the letter is sent, and the user hears about it once.
    const reads = statusReads;
    await tick(60000);
    assert.equal(statusReads, reads);
    assert.equal(toastCount(t("admin.letters.sent")), 1);
  });

  test("letter history pages, resends and reports an uncertain delivery", async () => {
    const data = complianceData({ active: true });
    data.sites[0] = { ...data.sites[0], complianceLetters: issuedLetters };
    const uncertain = {
      sk: "LETTER_EMAIL_ATTEMPT#j2",
      letterJobId: "j2",
      deliveryState: "uncertain",
    };
    const { api } = await openCompliance(data, (api) => {
      api.on("GET", /^sites\/s1\?view=letters$/, () => ({
        json: {
          items: [
            meta(data.sites[0]),
            letterEmail("j0", { number: 2 }),
            ...(api.calls("POST", /letter:resend/).length ? [uncertain] : []),
          ],
          nextCursor: "c2",
        },
      }));
      api.on("GET", /^sites\/s1\?view=letters&cursor=c2$/, () => ({
        json: {
          items: [
            meta(data.sites[0]),
            letterEmail("old", {
              number: 1,
              recipients: [],
              provider: "local-preview",
            }),
            { sk: "LETTER_EMAIL_ATTEMPT#old", deliveryState: "uncertain" },
          ],
        },
      }));
      api.on("POST", /^sites\/s1\/letter:resend$/, { json: { jobId: "j2" } });
      api.on("GET", /^sites\/s1\?view=status$/, () => ({
        json: { items: [meta(data.sites[0]), uncertain] },
      }));
    });
    assert.equal(
      $(`${letters} img`).getAttribute("src"),
      issuedLetters.current.previewUrl,
    );
    await openLetters();
    assert.equal($$(`${letters} tbody tr`).length, 1);
    await click("#more-letter-history");
    assert.equal($$(`${letters} tbody tr`).length, 2);
    assert.ok($(letters).textContent.includes(t("admin.letters.localPreview")));
    assert.ok(missing("#more-letter-history"));
    assert.ok(
      $(letters).textContent.includes(t("admin.letters.deliveryUncertain")),
    );
    await click("[data-resend-letter]");
    assert.match(api.calls("POST", /letter:resend/)[0].body.requestId, UUID);
    await untilToast(t("admin.toast.deliveryUncertain"));
  });

  test("a refused resend can be retried with the same request ID", async () => {
    const data = complianceData({ active: true });
    data.sites[0] = {
      ...data.sites[0],
      complianceLetters: { current: issuedLetters.current },
    };
    const { api } = await openCompliance(data, (api) =>
      api.fail(
        "POST",
        /^sites\/s1\/letter:resend$/,
        409,
        "letter_email_missing",
      ),
    );
    await openLetters();
    await click("[data-resend-letter]");
    assert.equal(
      $(
        "section[aria-labelledby='letters-title'] [data-form-save-error]",
      ).textContent.trim(),
      t("admin.letters.resendError"),
    );
    assert.equal($("[data-resend-letter]").disabled, false);
    api.on("POST", /^sites\/s1\/letter:resend$/, { json: { jobId: "j9" } });
    await click("[data-resend-letter]");
    const [first, second] = api.calls("POST", /letter:resend/);
    assert.equal(second.body.requestId, first.body.requestId);
  });

  test("a local preview send confirms without an email", async () => {
    const data = complianceData({ active: true });
    data.sites[0] = {
      ...data.sites[0],
      complianceLetters: {
        current: { fileName: "pending.pdf", termsVersionId: "tv1" },
      },
    };
    const preview = letterEmail("j3", { provider: "local-preview" });
    await openCompliance(data, (api) => {
      api.on("POST", /^sites\/s1\/letter:resend$/, { json: { jobId: "j3" } });
      api.on("GET", /^sites\/s1\?view=letters$/, () => ({
        json: {
          items: [
            meta(data.sites[0]),
            ...(api.calls("POST", /letter:resend/).length ? [preview] : []),
          ],
        },
      }));
      api.on("GET", /^sites\/s1\?view=status$/, () => ({
        json: { items: [meta(data.sites[0]), preview] },
      }));
    });
    await openLetters();
    await click("[data-resend-letter]");
    await untilToast(t("admin.letters.previewSent"));
    assert.ok($(letters).textContent.includes(t("admin.letters.localPreview")));
  });

  test("letter polling skips hidden tabs, survives failed reads and gives up after a minute", async () => {
    const data = complianceData({ active: true });
    data.sites[0] = {
      ...data.sites[0],
      complianceLetters: {
        current: { status: "Generating", termsVersionId: "tv1" },
      },
    };
    let reads = 0;
    const { api } = await openCompliance(data, (api) => {
      api.on("POST", /^sites\/s1\/letter:resend$/, { json: { jobId: "j4" } });
      api.on("GET", /^sites\/s1\?view=status$/, () => {
        reads += 1;
        return reads === 1
          ? { status: 503, json: { error: "unavailable" } }
          : { json: { items: [meta(data.sites[0])] } };
      });
    });
    assert.ok($(letters).textContent.includes("Generating"));
    await openLetters();
    await click("[data-resend-letter]");
    assert.equal(api.calls("POST", /letter:resend/).length, 1);
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    try {
      await tick(6000);
      assert.equal(reads, 0);
    } finally {
      delete (/** @type {any} */ (document).hidden);
    }
    await untilToast(t("admin.toast.letterStillPending"));
    assert.ok(reads > 2);
    const final = reads;
    await tick(60000);
    assert.equal(reads, final);
    assert.equal(toastCount(t("admin.toast.letterStillPending")), 1);
  });

  test("letter polling gives up one minute after the send", async () => {
    const data = complianceData({ active: true });
    data.sites[0] = { ...data.sites[0], complianceLetters: issuedLetters };
    await openCompliance(data, (api) => {
      api.on("POST", /^sites\/s1\/letter:resend$/, { json: { jobId: "j4" } });
      api.on("GET", /^sites\/s1\?view=status$/, () => ({
        json: { items: [meta(data.sites[0])] },
      }));
    });
    await openLetters();
    await click("[data-resend-letter]");
    await tick(59000);
    assert.equal(toastCount(t("admin.toast.letterStillPending")), 0);
    await tick(1000);
    assert.equal(toastCount(t("admin.toast.letterStillPending")), 1);
  });

  test("leaving the Site slows letter polling and stops the pending-letter check", async () => {
    const data = complianceData();
    let reads = 0;
    await openCompliance(data, (api) => {
      api.on("POST", /^sites\/s1\/terms$/, { json: { jobId: "j5" } });
      api.on("GET", /^sites\/s1\?view=status$/, () => {
        reads += 1;
        return {
          json: {
            items:
              reads < 3
                ? [meta(data.sites[0], { letterState: "draft_pending" })]
                : [meta(data.sites[0]), letterEmail("j5")],
          },
        };
      });
    });
    await click("[data-require-checks]");
    await click(save);
    await routeTo("/sites");
    await tick(1000);
    assert.equal(reads, 1);
    // Off the Site only the email check keeps going, now every 5 s.
    await tick(4000);
    assert.equal(reads, 1);
    await tick(1000);
    assert.equal(reads, 2);
    await untilToast(t("admin.letters.sent"), 5000);
  });

  test("letters show their generating and empty states", async () => {
    const data = complianceData();
    data.sites[0] = { ...data.sites[0], letterState: "draft_pending" };
    await openCompliance(data, (api) =>
      api.fail("GET", /^sites\/s1\?view=letters$/, 500, "letters_failed"),
    );
    assert.ok(
      $(letters).textContent.includes("The letter is being generated."),
    );
    // Pins a bug: compliance.templates.js hard-codes this instead of siteAdmin.letters.noPast,
    // which has no full stop. No issue filed yet.
    assert.ok($(letters).textContent.includes("No past letters."));
    await openLetters();
    assert.ok(!missing("admin-app [data-operation-error]"));
  });

  // compliance.templates.js hard-codes these labels; siteAdmin.letters.current and openPdf
  // have the same English, so this can't tell the two apart.
  for (const [current, shown] of [
    [{ status: "queued" }, "Current letter: queued"],
    [{}, "Current letter: Generating"],
    [{ url: "https://example.org/now.pdf" }, "Current letter: Open PDF"],
    [
      { previewUrl: "https://example.org/now.png", fileName: "now.pdf" },
      "Current letter: now.pdf",
    ],
  ])
    test(`letters show "${shown}" with no preview, and past letters without names`, async () => {
      const data = complianceData();
      data.sites[0] = {
        ...data.sites[0],
        complianceLetters: {
          current,
          past: [
            { url: "https://example.org/old.pdf" },
            { url: "https://example.org/sept.pdf", createdAt: "2026-09-01" },
            { fileName: "a.pdf" },
          ],
        },
      };
      await openCompliance(data);
      await openLetters();
      const panel = $(letters);
      assert.ok(panel.textContent.includes(shown));
      // The preview image is the only image the letters panel draws.
      assert.equal(panel.querySelector("img"), null);
      assert.deepEqual(
        [...panel.querySelectorAll("li")].map((item) => [
          item.textContent,
          Boolean(item.querySelector("a")),
        ]),
        [
          ["Previous letter", true],
          ["2026-09-01", true],
          ["a.pdf", false],
        ],
      );
    });

  test("a letter read that lands after leaving the Site is ignored", async () => {
    const data = complianceData();
    data.sites[0] = { ...data.sites[0], complianceLetters: issuedLetters };
    const held = gate();
    const { api } = await openCompliance(data, (api) =>
      api.on("GET", /^sites\/s1\?view=letters$/, async () => {
        await held.promise;
        return { status: 500, json: { error: "late" } };
      }),
    );
    await openLetters();
    assert.equal(api.calls("GET", /view=letters/).length, 1);
    await routeTo("/sites");
    held.release();
    await settle();
    assert.ok(missing("admin-app [data-operation-error]"));
    assert.ok(!missing("#directory-search-input"));
  });

  test("a letter list returning to an open panel reloads it", async () => {
    const data = complianceData();
    data.sites[0] = { ...data.sites[0], complianceLetters: issuedLetters };
    const { api } = await openCompliance(data);
    await openLetters();
    assert.equal(api.calls("GET", /view=letters/).length, 1);
    await click('a[href="/sites/s1?section=details"]');
    assert.ok(!missing("#site-details-form"));
    await click('a[href="/sites/s1?section=compliance"]');
    assert.equal(api.calls("GET", /view=letters/).length, 2);
    assert.equal($(letters).open, true);
  });

  for (const [active, key] of [
    [true, "admin.compliance.active"],
    [false, "admin.compliance.inactive"],
  ])
    test(`a Site ${active ? "with" : "without"} a requirement says it is ${active ? "active" : "inactive"}`, async () => {
      await openCompliance(complianceData({ active }));
      assert.equal(
        $("section[aria-labelledby='compliance-title'] p").textContent,
        t(key),
      );
    });

  test("ending the requirement explains what ending does", async () => {
    await openCompliance(complianceData({ active: true }));
    await click("[data-end-checks]");
    assert.equal(
      $("#end-checks-period-copy").textContent,
      t("admin.compliance.endConfirmation"),
    );
  });

  test("letters start closed and stay closed on the next Site", async () => {
    const data = complianceData();
    data.sites.push({ ...data.sites[0], siteId: "s3", name: "North Site" });
    await openCompliance(data);
    assert.equal($(letters).open, false);
    await openLetters();
    await routeTo("/sites/s3?section=compliance");
    assert.equal($(letters).open, false);
  });

  test("a letter list read again without an uncertain delivery clears its alert", async () => {
    const data = complianceData();
    data.sites[0] = { ...data.sites[0], complianceLetters: issuedLetters };
    const uncertain = letterEmail("j2", { deliveryState: "uncertain" });
    let reads = 0;
    await openCompliance(data, (api) =>
      api.on("GET", /^sites\/s1\?view=letters$/, () => ({
        json: {
          items: [meta(data.sites[0]), ...(++reads === 1 ? [uncertain] : [])],
        },
      })),
    );
    await openLetters();
    assert.ok(
      $(letters).textContent.includes(t("admin.letters.deliveryUncertain")),
    );
    await click('a[href="/sites/s1?section=details"]');
    await click('a[href="/sites/s1?section=compliance"]');
    assert.equal(reads, 2);
    assert.ok(
      !$(letters).textContent.includes(t("admin.letters.deliveryUncertain")),
    );
  });

  test("a letter read from before leaving and returning to the Site is dropped", async () => {
    const data = complianceData();
    data.sites[0] = { ...data.sites[0], complianceLetters: issuedLetters };
    data.sites.push({ ...data.sites[0], siteId: "s3", name: "North Site" });
    const held = gate();
    const { api } = await openCompliance(data, (api) =>
      api.on("GET", /^sites\/s1\?view=letters$/, async () => {
        await held.promise;
        return {
          json: {
            items: [
              meta(data.sites[0]),
              { sk: "LETTER_EMAIL_ATTEMPT#old", deliveryState: "uncertain" },
            ],
          },
        };
      }),
    );
    await openLetters();
    assert.equal(api.calls("GET", /view=letters/).length, 1);
    await routeTo("/sites/s3?section=compliance");
    await routeTo(compliancePath);
    held.release();
    await settle();
    assert.ok(
      !$(letters).textContent.includes(t("admin.letters.deliveryUncertain")),
    );
  });

  /** Serve a resend that always queues job j7, and a status read that reports it sent. */
  function resendSentLetter(
    /** @type {any} */ data,
    statusReads = { count: 0 },
  ) {
    data.sites[0] = { ...data.sites[0], complianceLetters: issuedLetters };
    return (/** @type {any} */ api) => {
      api.on("POST", /^sites\/s1\/letter:resend$/, { json: { jobId: "j7" } });
      api.on("GET", /^sites\/s1\?view=status$/, () => {
        statusReads.count += 1;
        return {
          json: {
            items: [
              meta(data.sites[0]),
              ...(statusReads.count >= 3 ? [letterEmail("j7")] : []),
            ],
          },
        };
      });
    };
  }

  test("a resend that returns a job already being checked adds no second check", async () => {
    const data = complianceData({ active: true });
    const statusReads = { count: 0 };
    await openCompliance(data, resendSentLetter(data, statusReads));
    await openLetters();
    await click("[data-resend-letter]");
    await tick(1200);
    assert.equal(statusReads.count, 1);
    // A retried resend with the same request ID gets the same job back.
    await click("[data-resend-letter]");
    // The running check reads next at 2.5 s; a second check would read at 2.2 s.
    await tick(1100);
    assert.equal(statusReads.count, 1);
    await untilToast(t("admin.letters.sent"));
    assert.equal(toastCount(t("admin.letters.sent")), 1);
  });

  test("a resend that returns a job already announced is not checked again", async () => {
    const data = complianceData({ active: true });
    const statusReads = { count: 0 };
    await openCompliance(data, resendSentLetter(data, statusReads));
    await openLetters();
    await click("[data-resend-letter]");
    await untilToast(t("admin.letters.sent"));
    const reads = statusReads.count;
    await click("[data-resend-letter]");
    await tick(10000);
    assert.equal(statusReads.count, reads);
  });

  test("a letter sent for a Site the user has left leaves the open Site's status alone", async () => {
    const data = complianceData({ active: true });
    data.sites.push({ ...data.sites[0], siteId: "s3", name: "North Site" });
    data.terms.push(...data.terms.map((term) => ({ ...term, siteId: "s3" })));
    await openCompliance(data, (api) => {
      resendSentLetter(data)(api);
      api.fail("POST", /^sites\/s3\/terms:close$/, 500, "close_failed");
    });
    await openLetters();
    await click("[data-resend-letter]");
    await routeTo("/sites/s3?section=compliance");
    await untilToast(t("admin.letters.sent"), 5000);
    // A failed end redraws the whole page, showing any status message left in it.
    await click("[data-end-checks]");
    await choose("confirm");
    // Pins a bug: the raw API code shows instead of a message. No issue filed yet.
    assert.equal(pageError(), "close_failed");
    assert.ok(!$("admin-app").textContent.includes(t("admin.letters.sent")));
  });
});
