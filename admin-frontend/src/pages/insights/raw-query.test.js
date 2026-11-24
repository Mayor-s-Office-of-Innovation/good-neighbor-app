import { test } from "vitest";
import assert from "node:assert/strict";
import {
  exportBody,
  isFiltered,
  rawApiParams,
  rawSearch,
  readRaw,
} from "./raw-query.js";

const october = /** @type {const} */ ({ kind: "month", month: "2026-10" });

test("a Raw data link drops values the server would refuse", () => {
  const state = readRaw(
    "issues",
    "?severityBand=awful&responseState=late&group=day&state=completed",
  );
  assert.equal(state.filters.severityBand, "");
  assert.equal(state.filters.responseState, "late");
  // Checks' filter means nothing on Issues, so it isn't kept.
  assert.equal(state.filters.state, undefined);
  assert.equal(state.group, "latest");
});

test("a link may still ask for Unknown severity, though the filter doesn't offer it", () => {
  assert.equal(
    readRaw("issues", "?severityBand=unknown").filters.severityBand,
    "unknown",
  );
});

test("a Raw data view survives the trip through its URL, with no search, source or page", () => {
  const search =
    "?period=2026-10&siteIds=s1%2Cs4&severityBand=severe&programId=p1&group=site";
  const state = readRaw("issues", search);
  assert.equal(rawSearch("issues", state, october), search);
  assert.equal(isFiltered(state), true);
  assert.equal(isFiltered(readRaw("issues", "?group=site")), false);
  // Hand-edited links may carry these; the page has no control for them.
  const old = readRaw("issues", "?q=pier&source=perimeter&cursor=c2");
  assert.equal(rawSearch("issues", old, null), "");
  assert.deepEqual(rawApiParams("issues", old, null), {
    sort: "latestActivityAt",
  });
});

test("the Site select narrows to one Site with siteIds", () => {
  const state = readRaw("issues", "?siteIds=s1");
  assert.deepEqual(state.siteIds, ["s1"]);
  assert.equal(rawApiParams("issues", state, october).siteIds, "s1");
});

test("each grouping asks the server for its own sort", () => {
  const sorts = ["latest", "created", "site"].map(
    (group) =>
      rawApiParams("issues", readRaw("issues", `?group=${group}`), october)
        .sort,
  );
  assert.deepEqual(sorts, ["latestActivityAt", "createdAt", "siteName"]);
  // The server refuses a missing sort, so an unknown grouping falls back.
  const odd = { ...readRaw("issues", ""), group: "day" };
  assert.equal(rawApiParams("issues", odd, october).sort, "latestActivityAt");
  // Checks have one order, so they send none.
  assert.equal(
    rawApiParams("checks", readRaw("checks", ""), null).sort,
    undefined,
  );
});

test("Checks always ask for perimeter Checks, as the Site page counts them", () => {
  assert.equal(
    rawApiParams("checks", readRaw("checks", "?source=single-problem"), null)
      .source,
    "perimeter",
  );
  assert.equal(
    rawApiParams("issues", readRaw("issues", ""), null).source,
    undefined,
  );
});

test("Load more asks with the reply's cursor; a new view starts without one", () => {
  const state = readRaw("issues", "?severityBand=severe");
  assert.equal(
    rawApiParams("issues", state, october, "next-2").cursor,
    "next-2",
  );
  assert.equal(rawApiParams("issues", state, october).cursor, undefined);
});

test("an export asks for every matching row, not the page on screen", () => {
  const state = readRaw("checks", "?state=unfinished&cursor=c2&siteIds=s1");
  assert.deepEqual(exportBody("checks", state, october), {
    dataset: "checks",
    period: "month",
    month: "2026-10",
    siteIds: "s1",
    state: "unfinished",
    source: "perimeter",
  });
});
