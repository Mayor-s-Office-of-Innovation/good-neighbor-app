import { test, vi } from "vitest";
import assert from "node:assert/strict";
import {
  $,
  $$,
  adminData,
  click,
  fill,
  mountAdmin,
  press,
  settle,
  tick,
  toastText,
  window,
  missing,
  focused,
} from "../test-support/admin-dom.js";
import { gate } from "../../e2e/admin-tests/admin-mock.js";
import { t } from "../../frontend/src/i18n/i18n.js";

// pages/site/save-error-messages.js and record.bindings.js have no catalog key for this copy, so tests match their English.

// The address search waits this long after typing before it asks for suggestions.
const SEARCH_DELAY_MS = 300;

const suggestion = {
  label: "200 Sample Ave, San Francisco, CA 94110",
  addressParts: {
    streetNumber: "200",
    streetAddress: "Sample Ave",
    city: "San Francisco",
    state: "CA",
    zip: "94110",
  },
};

const status = () => $("admin-app [data-address-status]").textContent.trim();
const results = () => $$("admin-app [data-address-results] button");
const field = (/** @type {string} */ name) =>
  $(`admin-app wa-input[name="${name}"]`);

/** @param {string} query */
async function search(query) {
  await fill('wa-input[name="address-query"]', query);
  await tick(SEARCH_DELAY_MS);
}

/** @param {Record<string, unknown>} site */
function siteData(site) {
  const data = adminData();
  data.sites[0] = { ...data.sites[0], ...site };
  return data;
}

test("a chosen suggestion fills the address and saves its parts", async () => {
  const { api } = await mountAdmin("/sites/s1", {
    setup: (api) =>
      api.on("POST", /^address-suggestions$/, {
        json: {
          suggestions: [
            suggestion,
            { label: "201 Sample Ave, San Francisco, CA 94110" },
          ],
        },
      }),
  });
  await click("[data-edit-address]");
  assert.equal($("[data-edit-address]").getAttribute("aria-expanded"), "true");
  assert.equal($("[data-address-editor]").hidden, false);
  assert.equal(status(), "");
  await fill('wa-input[name="address-query"]', "20");
  assert.equal(status(), "Type at least 3 characters.");
  await search("200 Sample");
  assert.equal(results().length, 2);
  assert.deepEqual(
    api.calls("POST", /^address-suggestions$/).map((call) => call.body.query),
    ["200 Sample"],
  );
  assert.equal(field("address-query").getAttribute("aria-expanded"), "true");
  await press(field("address-query"), "ArrowDown");
  assert.ok(document.activeElement === results()[0]);
  await click(results()[0]);
  assert.equal(field("street-address").value, "200 Sample Ave");
  assert.equal(field("zip").value, "94110");
  await click("[data-save-address]");
  assert.match(toastText(), new RegExp(t("admin.toast.addressSaved")));
  const [patch] = api.calls("PATCH", /^sites\/s1$/);
  assert.deepEqual(patch.body.addressParts, {
    streetNumber: "200",
    streetAddress: "Sample Ave",
    secondLine: "",
    city: "San Francisco",
    state: "CA",
    zip: "94110",
  });
  assert.equal(patch.body.name, "Example Site");
  assert.equal(patch.body.publicContact, undefined);
});

test("an address the geocoder cannot place stays on the form with why", async () => {
  const { api } = await mountAdmin("/sites/s1", {
    setup: (api) => api.fail("PATCH", /^sites\/s1$/, 422, "address_not_found"),
  });
  await click("[data-edit-address]");
  await click("[data-enter-address-manually]");
  await fill(field("street-address"), "300 Example Way");
  await fill(field("state"), "ca");
  await click("[data-save-address]");
  assert.equal(
    $("#site-details-form [data-form-save-error]").textContent.trim(),
    "We couldn't geocode this address. Check it and try again.",
  );
  const { addressParts } = api.calls("PATCH", /^sites\/s1$/)[0].body;
  assert.deepEqual(
    [addressParts.streetNumber, addressParts.streetAddress, addressParts.state],
    ["300", "Example Way", "CA"],
  );
});

test("address lookup reports no results, one result and an outage", async () => {
  /** @type {any[]} */
  const answers = [
    { json: {} },
    { json: { suggestions: [suggestion] } },
    { status: 503, json: { error: "address_search_unavailable" } },
  ];
  await mountAdmin("/sites/s1", {
    setup: (api) =>
      api.on("POST", /^address-suggestions$/, () => answers.shift()),
  });
  await click("[data-edit-address]");
  await search("No such place");
  assert.equal(
    status(),
    "No matching addresses found. You can enter the address manually.",
  );
  assert.equal(results().length, 0);
  await search("200 Sample");
  assert.equal(status(), "1 address suggestion available.");
  assert.equal(results().length, 1);
  await press(field("address-query"), "Escape");
  assert.equal(results().length, 0);
  await search("200 Sample Av");
  assert.equal(
    status(),
    "Address suggestions are unavailable. Enter the address manually.",
  );
  assert.equal(results().length, 0);
  await fill('wa-input[name="address-query"]', "");
  assert.equal(status(), "");
});

test("a newer search cancels the one in flight", async () => {
  const held = gate();
  let calls = 0;
  await mountAdmin("/sites/s1", {
    setup: (api) =>
      api.on("POST", /^address-suggestions$/, async () => {
        calls += 1;
        if (calls === 1) {
          await held.promise;
          return { json: { suggestions: [suggestion, suggestion] } };
        }
        return { json: { suggestions: [suggestion] } };
      }),
  });
  await click("[data-edit-address]");
  // The stale-answer check alone would also drop the first reply, so watch
  // that request's own signal; typing aborts finished searches too.
  const fetches = vi.spyOn(globalThis, "fetch");
  await search("200 Sample");
  const [first] = fetches.mock.calls.filter((args) =>
    String(args[0]).endsWith("/address-suggestions"),
  );
  assert.equal(first[1].signal.aborted, false);
  await search("200 Sample Ave");
  assert.equal(first[1].signal.aborted, true);
  held.release();
  await settle();
  assert.equal(calls, 2);
  assert.equal(results().length, 1);
});

test("suggestions for an outdated query are dropped", async () => {
  const held = gate();
  await mountAdmin("/sites/s1", {
    setup: (api) =>
      api.on("POST", /^address-suggestions$/, async () => {
        await held.promise;
        return { json: { suggestions: [suggestion] } };
      }),
  });
  await click("[data-edit-address]");
  await search("200 Sample");
  field("address-query").value = "Somewhere else";
  held.release();
  await settle();
  assert.equal(results().length, 0);
  field("address-query").dispatchEvent(new window.Event("wa-clear"));
  assert.equal(status(), "");
});

test("manual entry toggles and Cancel edit restores the saved address", async () => {
  await mountAdmin("/sites/s1");
  const fields = () => $("admin-app [data-address-fields]");
  await click("[data-edit-address]");
  await click("[data-enter-address-manually]");
  assert.equal(
    $("[data-enter-address-manually]").getAttribute("aria-expanded"),
    "true",
  );
  assert.equal(fields().hidden, false);
  await fill(field("city"), "Oakland");
  assert.equal($("[data-save-address]").disabled, false);
  await click("[data-enter-address-manually]");
  assert.equal(
    $("[data-enter-address-manually]").getAttribute("aria-expanded"),
    "false",
  );
  assert.equal(fields().hidden, true);
  await click("[data-enter-address-manually]");
  assert.equal(fields().hidden, false);
  await click("[data-edit-address]");
  assert.equal($("[data-edit-address]").getAttribute("aria-expanded"), "false");
  assert.equal($("[data-address-display]").hidden, false);
  assert.equal(fields().hidden, true);
  assert.equal(field("city").value, "San Francisco");
  assert.equal($("[data-save-address]").disabled, true);
  assert.ok(focused("[data-edit-address]"));
});

test("a Site without an address opens straight into the address editor", async () => {
  await mountAdmin("/sites/s1", {
    data: siteData({ address: "", addressParts: undefined }),
  });
  assert.ok(missing("[data-edit-address]"));
  assert.equal($("admin-app [data-address-editor]").hidden, false);
});

test("a legacy one-line address fills the address fields", async () => {
  await mountAdmin("/sites/s1", {
    data: siteData({
      address: "400 Legacy Rd, San Francisco, ca 94107",
      addressParts: undefined,
    }),
  });
  assert.equal(
    $("[data-address-display]").textContent.trim(),
    "400 Legacy Rd, San Francisco, ca 94107",
  );
  assert.equal(field("street-address").value, "400 Legacy Rd");
  assert.equal(field("state").value, "CA");
});

for (const address of [
  "Somewhere in the city",
  "Broadway, San Francisco, CA 94107",
])
  test(`an unparseable legacy address "${address}" leaves the fields empty`, async () => {
    await mountAdmin("/sites/s1", {
      data: siteData({ address, addressParts: undefined }),
    });
    assert.equal($("[data-address-display]").textContent.trim(), address);
    assert.equal(field("city").value, "");
  });

test("a suggestion missing address parts fills only what it has", async () => {
  await mountAdmin("/sites/s1", {
    setup: (api) =>
      api.on("POST", /^address-suggestions$/, {
        json: {
          suggestions: [
            {
              label: "Sample Ave",
              addressParts: { streetAddress: "Sample Ave" },
            },
            { label: "Somewhere" },
          ],
        },
      }),
  });
  await click("[data-edit-address]");
  await search("Sample");
  await click(results()[0]);
  assert.equal(field("street-address").value, "Sample Ave");
  assert.equal(field("city").value, "");
  await search("Somewhere");
  await click(results().at(-1));
  assert.equal(field("street-address").value, "");
});

test("structured address parts show when there is no one-line address", async () => {
  await mountAdmin("/sites/s1", {
    data: siteData({
      address: "",
      addressParts: {
        streetNumber: "500",
        streetAddress: "Parts Blvd",
        city: "San Francisco",
        state: "CA",
        zip: "94102",
      },
    }),
  });
  assert.equal(
    $("[data-address-display]").textContent.trim(),
    "500 Parts Blvd, San Francisco, CA 94102",
  );
});

test("an invalid ZIP is not sent", async () => {
  const { api } = await mountAdmin("/sites/s1");
  await click("[data-edit-address]");
  await click("[data-enter-address-manually]");
  await fill(field("zip"), "123");
  assert.equal($("[data-save-address]").disabled, false);
  await click("[data-save-address]");
  assert.deepEqual(api.calls("PATCH", /^sites\/s1$/), []);
});
