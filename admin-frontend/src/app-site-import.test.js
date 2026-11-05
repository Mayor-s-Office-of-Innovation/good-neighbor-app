import { test, vi } from "vitest";
import assert from "node:assert/strict";
import {
  $,
  $$,
  byText,
  click,
  mountAdmin,
  pageError,
  routeTo,
  settle,
  submit,
  toastText,
  userEvent,
  window,
  missing,
  focused,
} from "../test-support/admin-dom.js";
import { gate } from "../../e2e/admin-tests/admin-mock.js";
import { failTimes } from "../../e2e/admin-tests/directory-helpers.js";
import {
  importPreview as preview,
  importRows as rows,
} from "../../e2e/admin-tests/site-import-helpers.js";
import { t } from "../../frontend/src/i18n/i18n.js";

// pages/site/import.templates.js has no catalog key for this copy, so tests match its English.

const CSV = "Provider,Program,Site name\nExample,Example,Example\n";

const pastImports = () => $('[aria-labelledby="past-imports-title"]');
const review = () => $('[aria-labelledby="review-title"]');
const results = () => $('[aria-labelledby="import-results-title"]');
const url = () => window.location.pathname + window.location.search;

// happy-dom's own validity check can't see a file set from a test, so tests
// submit the form directly after choosing one.

/** Choose a file as the file picker would. @param {string} [content] @param {string} [name] */
async function chooseFile(content = CSV, name = "sites.csv") {
  const input = $('input[name="site-import-file"]');
  const files =
    content === "" && name === ""
      ? []
      : [new window.File([content], name, { type: "text/csv" })];
  Object.defineProperty(input, "files", { configurable: true, value: files });
  input.dispatchEvent(userEvent("change"));
  await settle();
}

async function choosePreview() {
  await chooseFile();
  await submit("#site-import-form");
  assert.ok(!missing("#review-title"));
}

/** @param {Parameters<typeof mountAdmin>[1]["setup"]} setup */
const openImport = (setup, path = "/sites/import") =>
  mountAdmin(path, { setup });

test("past imports show each result and the upload help", async () => {
  await openImport((api) => {
    api.data.imports = [
      {
        fileName: "done.csv",
        completedAt: "2026-10-20T10:00:00Z",
        recordsAdded: 2,
        recordsUpdated: 1,
      },
      { resultStatus: "failed", recordsFailed: 3 },
      { outcomes: { failed: 1, skipped_conflict: 1 }, recordsAdded: 1 },
      { outcomes: { failed: 2 } },
      { resultStatus: "partial", completedAt: "not a date" },
    ];
  });
  const history = [...pastImports().querySelectorAll("tbody tr")].map(
    (row) => row.textContent,
  );
  assert.equal(history.length, 5);
  assert.match(history[0], /Completed/);
  assert.match(history[1], /Imported CSV/);
  assert.match(history[1], /Failed/);
  assert.match(history[1], /3 failed/);
  assert.match(history[2], /Partial/);
  assert.match(history[3], /Failed/);
  assert.match(history[4], /Not available/);
  await click("#show-import-help");
  assert.equal($("#site-import-help-dialog").open, true);
});

test("an empty or unreadable import history shows the empty row", async () => {
  const { api } = await openImport((api) => {
    api.data.imports = [{ fileName: "old.csv" }];
    api.fail("GET", /^site-imports$/);
  });
  assert.match(pastImports().textContent, /No past imports\./);
  const reopen = async () => {
    await routeTo("/sites");
    assert.ok(!missing("#directory-title"));
    await routeTo("/sites/import");
  };
  api.on("GET", /^site-imports$/, { json: { imports: api.data.imports } });
  await reopen();
  assert.match(pastImports().textContent, /old\.csv/);
  api.on("GET", /^site-imports$/, { json: {} });
  await reopen();
  assert.match(pastImports().textContent, /No past imports\./);
  assert.doesNotMatch(pastImports().textContent, /old\.csv/);
});

test("the chosen file name is announced and cleared", async () => {
  await openImport();
  await chooseFile();
  assert.equal($("#site-import-file-name").textContent.trim(), "sites.csv");
  assert.equal($("#site-import-file-name").hidden, false);
  await chooseFile("", "");
  assert.equal($("#site-import-file-name").hidden, true);
});

test("a preview lists every row status and reason", async () => {
  const { api } = await openImport((api) =>
    api.on("POST", /^site-imports\/preview$/, { json: preview }),
  );
  await choosePreview();
  assert.match(url(), /importId=i1/);
  assert.deepEqual(
    api.calls("POST", /^site-imports\/preview$/)[0].body.fileName,
    "sites.csv",
  );
  // Rows only: the summary above them always lists Perfect, Acceptable and Not ready.
  const text = [...review().querySelectorAll("tbody")]
    .map((body) => body.textContent)
    .join(" ");
  for (const expected of [
    "Perfect",
    "Acceptable",
    "Not ready",
    "Imported",
    "Retry needed",
    "Not imported",
    "Missing optional: Site manager phone",
    "Optional fields missing",
    "Missing: Site address",
    "Missing required value",
    "site_conflict",
    "Temporary service error. The importer will retry this row.",
    "The temporary service error persisted, so this row was not imported.",
    "The underlying data changed after this preview was created.",
    "The importer encountered an unexpected error.",
  ])
    assert.ok(text.includes(expected), expected);
  // Cells: status, row number, Site, provider, Program, reason.
  const row9 = [...review().querySelectorAll("tbody tr")]
    .map((row) => [...row.cells].map((cell) => cell.textContent.trim()))
    .find((cells) => cells[1] === "9");
  assert.equal(row9?.[5], "—");
  assert.deepEqual(
    [...review().querySelectorAll("dd")].map((value) =>
      value.textContent.trim(),
    ),
    ["2", "2", "4"],
  );
  assert.ok(!missing("#download-import-conflicts"));
});

test("an oversized file or failed preview shows a plain-language error", async () => {
  const { api } = await openImport((api) =>
    api.fail("POST", /^site-imports\/preview$/, 400, "unreadable_csv"),
  );
  await chooseFile("a".repeat(1024 * 1024 + 1));
  await submit("#site-import-form");
  assert.equal(pageError(), t("admin.import.fileTooLarge"));
  await chooseFile();
  await submit("#site-import-form");
  assert.equal(pageError(), t("admin.import.unreadableCsv"));
  assert.ok(!missing("#upload-title"));
  api.fail("POST", /^site-imports\/preview$/, 400, "synthetic_server_code");
  await chooseFile();
  await submit("#site-import-form");
  assert.equal(pageError(), t("admin.toast.requestFailed"));
});

test("submitting without a file does nothing", async () => {
  const { api } = await openImport();
  await submit("#site-import-form");
  assert.ok(!missing("#upload-title"));
  assert.equal(pageError(), "");
  assert.deepEqual(api.calls("POST", /^site-imports/), []);
});

test("applying polls until complete and confirms success", async () => {
  const replies = [
    { status: "applying", outcomes: { applied: 1 }, rows: rows.slice(0, 2) },
    { status: "complete", resultStatus: "succeeded", outcomes: { applied: 2 } },
  ];
  const { api } = await openImport((api) => {
    api.on("POST", /^site-imports\/preview$/, {
      json: { ...preview, counts: { create: 2 }, rows: rows.slice(0, 2) },
    });
    api.on("POST", /^site-imports\/i1\/apply$/, () => ({
      json: replies.shift(),
    }));
  });
  await choosePreview();
  assert.ok(missing("#download-import-conflicts"));
  await click("#apply-site-import");
  assert.equal(
    results().querySelector("p").textContent.trim(),
    t("admin.import.outcomeCounts", { applied: 2, failed: 0 }),
  );
  assert.ok(missing("#apply-site-import"));
  assert.equal(url(), "/sites/import?importId=i1");
  const applies = api.calls("POST", /^site-imports\/i1\/apply$/);
  assert.equal(applies.length, 2);
  assert.match(applies[0].body.idempotencyKey, /^[0-9a-f-]{36}$/);
  assert.equal(applies[1].body.idempotencyKey, applies[0].body.idempotencyKey);
  assert.ok(
    toastText().includes(t("admin.toast.importComplete", { count: 2 })),
  );
  assert.ok(missing("#dismiss-import-notice"));
  await click("#cancel-site-import");
  assert.ok(!missing("#upload-title"));
  assert.equal(url(), "/sites/import");
});

for (const [name, result, title] of [
  [
    "all rows failed",
    { status: "complete", outcomes: { failed: 2 } },
    "admin.toast.importFailed",
  ],
  [
    "the result failed after some rows applied",
    { status: "complete", resultStatus: "failed", outcomes: { applied: 1 } },
    "admin.toast.importPartial",
  ],
  [
    "some rows were skipped",
    { status: "complete", outcomes: { applied: 1, skipped_conflict: 1 } },
    "admin.toast.importPartial",
  ],
  [
    "the result is partial with nothing applied",
    { status: "complete", resultStatus: "partial", outcomes: {} },
    "admin.toast.importFailed",
  ],
])
  test(`a completed import explains when ${name}`, async () => {
    await openImport((api) => {
      api.on("POST", /^site-imports\/preview$/, { json: preview });
      api.on("POST", /^site-imports\/i1\/apply$/, { json: result });
    });
    await choosePreview();
    await click("#apply-site-import");
    assert.ok(!missing("#dismiss-import-notice"));
    assert.ok(
      $("admin-app section[role='status']").textContent.includes(
        t(/** @type {string} */ (title)),
      ),
    );
    await click("#dismiss-import-notice");
    assert.ok(missing("#dismiss-import-notice"));
  });

test("a history refresh failure after import is reported, not fatal", async () => {
  const { api } = await openImport((api) => {
    api.on("POST", /^site-imports\/preview$/, { json: preview });
    api.on("POST", /^site-imports\/i1\/apply$/, {
      json: { status: "complete", outcomes: { applied: 1 } },
    });
  });
  await choosePreview();
  api.fail("GET", /^site-imports$/);
  await click("#apply-site-import");
  assert.ok(toastText().includes(t("admin.import.historyRefreshFailed")));
  assert.ok(!missing("#import-results-title"));
});

test("a history refresh failure after import keeps the earlier history", async () => {
  const { api } = await openImport((api) => {
    api.data.imports = [{ importId: "i0", fileName: "earlier.csv" }];
    api.on("POST", /^site-imports\/preview$/, { json: preview });
    api.on("POST", /^site-imports\/i1\/apply$/, {
      json: { status: "complete", outcomes: { applied: 1 } },
    });
  });
  await choosePreview();
  api.fail("GET", /^site-imports$/);
  await click("#apply-site-import");
  await click("#cancel-site-import");
  assert.match(pastImports().textContent, /earlier\.csv/);
});

test("a failed apply keeps the preview and shows the error", async () => {
  await openImport((api) => {
    api.on("POST", /^site-imports\/preview$/, { json: preview });
    api.fail("POST", /^site-imports\/i1\/apply$/, 409, "stale_preview");
  });
  await choosePreview();
  await click("#apply-site-import");
  // An API code is not something a user can act on, so it never shows.
  assert.equal(pageError(), t("admin.toast.requestFailed"));
  assert.ok(!missing("#review-title"));
  assert.equal($("#apply-site-import").disabled, false);
});

test("returning to the import page mid-apply shows it still working", async () => {
  const held = gate();
  await openImport((api) => {
    api.on("POST", /^site-imports\/preview$/, { json: preview });
    api.on("POST", /^site-imports\/i1\/apply$/, async () => {
      await held.promise;
      return { json: { status: "complete", outcomes: { applied: 1 } } };
    });
  });
  await choosePreview();
  await click("#apply-site-import");
  assert.ok(review().querySelector('[role="status"]'));
  await routeTo("/sites");
  assert.ok(!missing("#directory-title"));
  await routeTo("/sites/import?importId=i1");
  assert.ok(review().querySelector('[role="status"]'));
  await routeTo("/providers");
  assert.ok(!missing('a[href="/providers/v1"]'));
  held.release();
  await settle();
  assert.equal(url(), "/providers");
  assert.ok(missing("#upload-title"));
});

test("cancel returns to the upload form", async () => {
  await openImport((api) =>
    api.on("POST", /^site-imports\/preview$/, { json: preview }),
  );
  await choosePreview();
  await click("#cancel-site-import");
  assert.ok(!missing("#upload-title"));
  assert.equal(url(), "/sites/import");
  assert.ok(focused('input[name="site-import-file"]'));
});

test("the conflict report downloads, or reports a failure", async () => {
  /** @type {string[]} */
  const downloads = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:conflicts");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(window.HTMLAnchorElement.prototype, "click").mockImplementation(
    function () {
      downloads.push(this.download);
    },
  );
  const { api } = await openImport((api) => {
    api.on("POST", /^site-imports\/preview$/, { json: preview });
    api.on("GET", /^site-imports\/i1\/conflicts\.csv$/, {
      body: "Row,Reason\n8,site_conflict\n",
      contentType: "text/csv",
    });
  });
  await choosePreview();
  await click("#download-import-conflicts");
  assert.deepEqual(downloads, ["site-import-i1-conflicts.csv"]);
  api.fail("GET", /^site-imports\/i1\/conflicts\.csv$/);
  await click("#download-import-conflicts");
  // Pins a bug: the raw API code shows instead of a message. No issue filed yet.
  assert.equal(pageError(), "conflict_report_failed");
});

test("apply progress updates while rows are still applying", async () => {
  const second = gate();
  const last = gate();
  const replies = [
    () => ({ status: "applying", outcomes: { failed: 1 } }),
    async () => {
      await second.promise;
      return { status: "applying", outcomes: { skipped_conflict: 1 } };
    },
    async () => {
      await last.promise;
      return { status: "complete", outcomes: { applied: 1 } };
    },
  ];
  const { api } = await openImport((api) => {
    api.on("POST", /^site-imports\/preview$/, {
      json: { ...preview, counts: { create: 1 }, rows: rows.slice(0, 1) },
    });
    api.on("POST", /^site-imports\/i1\/apply$/, async () => ({
      json: await replies.shift()?.(),
    }));
  });
  await choosePreview();
  await click("#apply-site-import");
  const progress = () =>
    review().querySelector('[role="status"]').textContent.trim();
  assert.equal(
    progress(),
    t("admin.import.outcomeCounts", { applied: 0, failed: 1 }),
  );
  second.release();
  await settle();
  assert.equal(api.calls("POST", /^site-imports\/i1\/apply$/).length, 3);
  // Pins a bug: the progress line counts only failed rows, so this poll's
  // skipped_conflict row reads as 0. No issue filed yet.
  assert.equal(
    progress(),
    t("admin.import.outcomeCounts", { applied: 0, failed: 0 }),
  );
  last.release();
  await settle();
  assert.ok(!missing("#import-results-title"));
});

test("an import link reopens its preview with the saved key", async () => {
  const { api } = await openImport((api) => {
    api.on("GET", /^site-imports\/i1$/, {
      json: {
        import: {
          status: "previewed",
          previewVersion: 3,
          counts: { create: 1 },
          idempotencyKey: "server-key",
        },
        rows: rows.slice(0, 1),
      },
    });
    api.on("POST", /^site-imports\/i1\/apply$/, {
      json: { status: "complete", outcomes: { applied: 1 } },
    });
  }, "/sites/import?importId=i1");
  assert.ok(!missing("#review-title"));
  await click("#apply-site-import");
  assert.ok(!missing("#import-results-title"));
  assert.deepEqual(api.calls("POST", /^site-imports\/i1\/apply$/)[0].body, {
    previewVersion: 3,
    idempotencyKey: "server-key",
  });
});

test("an import link without a stored key makes a new one", async () => {
  await openImport(
    (api) =>
      api.on("GET", /^site-imports\/i1$/, {
        json: { import: { status: "previewed", previewVersion: 1 }, rows: [] },
      }),
    "/sites/import?importId=i1",
  );
  assert.ok(!missing("#review-title"));
  assert.deepEqual(
    [...review().querySelectorAll("dd")].map((value) =>
      value.textContent.trim(),
    ),
    ["0", "0", "0"],
  );
  assert.match(
    window.sessionStorage.getItem("site-import-key:i1"),
    /^[0-9a-f-]{36}$/,
  );
});

test("a finished import link shows its results and cannot be applied again", async () => {
  await openImport(
    (api) =>
      api.on("GET", /^site-imports\/i2$/, {
        json: {
          import: {
            status: "complete",
            outcomes: { applied: 1, failed: 1, skipped_conflict: 1 },
          },
          rows: [
            { rowNumber: 2, outcome: "applied" },
            {
              rowNumber: 3,
              outcome: "skipped_conflict",
              reasonCode: "import_dependency_failed",
            },
          ],
        },
      }),
    "/sites/import?importId=i2",
  );
  assert.equal(url(), "/sites/import?importId=i2");
  assert.ok(missing("#apply-site-import"));
  assert.ok(missing("#upload-title"));
  const text = results().textContent;
  assert.ok(
    text.includes(t("admin.import.outcomeCounts", { applied: 1, failed: 2 })),
  );
  assert.ok(text.includes(t("admin.import.dependencyFailed")));
  assert.ok(byText(t("admin.import.downloadConflicts")));
  await click(byText(t("admin.import.startNew")));
  assert.ok(!missing("#upload-title"));
  assert.equal(url(), "/sites/import");
});

test("a past import opens its results from the history table", async () => {
  await openImport((api) => {
    api.data.imports = [
      {
        importId: "i 4",
        fileName: "done.csv",
        status: "complete",
        outcomes: { applied: 1 },
      },
    ];
  });
  await click(byText("done.csv", "a"));
  assert.equal(url(), "/sites/import?importId=i%204");
  assert.ok(
    results().textContent.includes(
      t("admin.import.outcomeCounts", { applied: 1, failed: 0 }),
    ),
  );
  assert.ok(missing("#download-import-conflicts"));
});

test("a notice from a finished import clears on the way back to the upload form", async () => {
  await openImport((api) => {
    api.on("POST", /^site-imports\/preview$/, { json: preview });
    api.on("POST", /^site-imports\/i1\/apply$/, {
      json: { status: "complete", outcomes: { failed: 1 } },
    });
  });
  await choosePreview();
  await click("#apply-site-import");
  assert.ok(!missing("#dismiss-import-notice"));
  await routeTo("/sites/import");
  assert.ok(missing("#dismiss-import-notice"));
});

test("an unreadable import link shows the error and a retry", async () => {
  await openImport((api) => {
    api.on("GET", /^site-imports\/i3$/, {
      json: { import: { status: "previewed", previewVersion: 1 }, rows: [] },
    });
    api.on("GET", /^site-imports\/i3$/, failTimes(1, 404, "import_not_found"));
  }, "/sites/import?importId=i3");
  // Pins a bug: the raw API code shows instead of a message. No issue filed yet.
  assert.equal(pageError(), "import_not_found");
  await click("#retry-page-load");
  assert.ok(!missing("#review-title"));
  assert.equal(pageError(), "");
});

test("an apply that ends in an unknown state keeps the preview", async () => {
  await openImport((api) => {
    api.on("POST", /^site-imports\/preview$/, { json: preview });
    api.on("POST", /^site-imports\/i1\/apply$/, { json: { status: "queued" } });
  });
  await choosePreview();
  await click("#apply-site-import");
  assert.equal($("#apply-site-import").disabled, false);
  assert.ok(!missing("#review-title"));
  assert.match(url(), /importId=i1/);
});

test("an import history reply without a list empties the table", async () => {
  const { api } = await openImport((api) => {
    api.data.imports = [{ fileName: "old.csv" }];
    api.on("POST", /^site-imports\/preview$/, { json: preview });
    api.on("POST", /^site-imports\/i1\/apply$/, {
      json: { status: "complete", outcomes: { applied: 1 } },
    });
  });
  await choosePreview();
  api.on("GET", /^site-imports$/, { json: {} });
  await click("#apply-site-import");
  await click(byText(t("admin.import.startNew")));
  assert.match(pastImports().textContent, /No past imports\./);
});

test("a Compliance manager reaches the upload form by URL though the menu hides Import", async () => {
  const { api } = await mountAdmin("/sites/import", {
    role: "compliance-manager",
    setup: (api) => (api.data.imports = [{ fileName: "old.csv" }]),
  });
  assert.ok(missing('a[href="/sites/import"]'));
  // Pins a gap: the import route has no capability check, so the upload form
  // shows to a Compliance manager. No issue filed yet.
  assert.ok(!missing("#upload-title"));
  // The backend refuses their history read with a 403, and the table reads as empty, with no error.
  assert.equal(api.calls("GET", /^site-imports$/).length, 1);
  assert.match(pastImports().textContent, /No past imports\./);
  assert.doesNotMatch(pastImports().textContent, /old\.csv/);
  assert.equal(pageError(), "");
  assert.equal(toastText(), "");
});
