import { test } from "vitest";
import assert from "node:assert/strict";
import { MAX_REPORT_SITES } from "./insights-query.js";
import {
  arrival,
  pickAll,
  pickOne,
  plainClick,
  siteToFocus,
} from "./overview-rules.js";

const october = "/insights?period=2026-10&show=all";
const september = "/insights?period=2026-09&show=all";

test("picks come back only on the exact view they were made on", () => {
  const back = { path: october, alsoPath: "", selected: ["s1"] };
  assert.deepEqual(arrival(back, october), {
    selected: ["s1"],
    returning: true,
  });
  assert.deepEqual(arrival(back, september), {
    selected: [],
    returning: false,
  });
});

test("Back at the period picked on the Site counts as a return, without the picks", () => {
  const back = { path: october, alsoPath: september, selected: ["s1"] };
  assert.deepEqual(arrival(back, september), {
    selected: [],
    returning: true,
  });
});

test("the picks aren't shared with the view they came back to", () => {
  const back = { path: october, alsoPath: "", selected: ["s1"] };
  const { selected } = arrival(back, october);
  selected.push("s2");
  assert.deepEqual(back.selected, ["s1"]);
});

test("select all keeps the user's picks first, then adds the rest in list order", () => {
  assert.deepEqual(pickAll(["s3"], ["s1", "s2", "s3"], true), [
    "s3",
    "s1",
    "s2",
  ]);
  assert.deepEqual(pickAll(["s3"], ["s1", "s2", "s3"], false), []);
});

test("select all stops at the most Sites one report takes", () => {
  const ids = Array.from({ length: MAX_REPORT_SITES + 1 }, (_, i) => `s${i}`);
  const picked = pickAll([], ids, true);
  assert.equal(picked.length, MAX_REPORT_SITES);
  assert.equal(picked.at(-1), `s${MAX_REPORT_SITES - 1}`);
});

test("a box adds its Site last, and unticking takes only that Site out", () => {
  assert.deepEqual(pickOne(["s1"], "s2", true), ["s1", "s2"]);
  assert.deepEqual(pickOne(["s1", "s2"], "s1", true), ["s2", "s1"]);
  assert.deepEqual(pickOne(["s1", "s2"], "s1", false), ["s2"]);
});

test("focus returns to the Site only on the view it was opened from", () => {
  const back = { siteId: "s4", path: october, alsoPath: september };
  assert.equal(siteToFocus(back, october), "s4");
  assert.equal(siteToFocus(back, september), "s4");
  assert.equal(siteToFocus(back, "/insights?period=2026-08"), "");
  assert.equal(siteToFocus({ ...back, siteId: "" }, october), "");
});

test("only a plain left click counts as a click on the page", () => {
  const click = { button: 0, metaKey: false, ctrlKey: false };
  const event = (/** @type {Record<string, unknown>} */ change) =>
    /** @type {MouseEvent} */ (
      /** @type {unknown} */ ({
        ...click,
        shiftKey: false,
        altKey: false,
        ...change,
      })
    );
  assert.deepEqual(
    [
      {},
      { metaKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
    ].map((change) => plainClick(event(change))),
    [true, false, false, false, false, false],
  );
});
