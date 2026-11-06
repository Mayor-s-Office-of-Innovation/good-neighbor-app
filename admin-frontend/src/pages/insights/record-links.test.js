import { test } from "vitest";
import assert from "node:assert/strict";
import {
  MAX_HOPS,
  panelFrom,
  readVia,
  recordHref,
  viaTo,
} from "./record-links.js";

/** @param {"issue" | "check"} kind @param {string} id @param {string} [siteId] */
const rec = (kind, id, siteId = "s1") => ({ kind, id, siteId });

/** @param {string} href */
const searchOf = (href) => `?${href.split("?")[1]}`;

test("a record link names its Site and list, and keeps only the period", () => {
  const href = recordHref(rec("issue", "t1"), {
    search: "?period=2026-10&severityBand=severe",
    back: "/insights/raw/issues?period=2026-10&severityBand=severe",
  });
  assert.equal(href.split("?")[0], "/insights/raw/issues/t1");
  const query = new URLSearchParams(searchOf(href));
  assert.deepEqual(
    [query.get("period"), query.get("siteId"), query.get("severityBand")],
    ["2026-10", "s1", null],
  );
  assert.equal(
    query.get("return"),
    "/insights/raw/issues?period=2026-10&severityBand=severe",
  );
});

test("records opened on the way read back from the link in order, even with : or / in an ID", () => {
  const via = [rec("issue", "t:1", "s/1"), rec("check", "c 1")];
  const href = recordHref(rec("issue", "t2"), { search: "", back: "", via });
  assert.equal(href.split("?")[0], "/insights/raw/issues/t2");
  assert.deepEqual(readVia(searchOf(href)), via);
});

test("a link keeps only the last ten records on the way", () => {
  const via = Array.from({ length: MAX_HOPS + 3 }, (_, i) =>
    rec("check", `c${i}`),
  );
  const search = searchOf(
    recordHref(rec("issue", "t1"), { search: "", back: "", via }),
  );
  assert.equal(new URLSearchParams(search).getAll("via").length, MAX_HOPS);
  const read = readVia(search);
  assert.deepEqual(read[0], rec("check", "c3"));
  assert.deepEqual(read.at(-1), rec("check", `c${MAX_HOPS + 2}`));
});

test("a crafted link with too many records on the way is cut to the last ten", () => {
  const search = `?${Array.from({ length: 50 }, (_, i) => `via=check:s1:c${i}`).join("&")}`;
  const read = readVia(search);
  assert.equal(read.length, MAX_HOPS);
  assert.equal(read[0].id, "c40");
});

test("records on the way that don't read as a kind, Site and ID are skipped", () => {
  assert.deepEqual(
    readVia(
      "?via=site:s1:x&via=issue::t1&via=issue:s1&via=check:s1:%E0%A4%A&via=issue:s1:t1:extra&via=check:s1:c1",
    ),
    [rec("check", "c1")],
  );
});

test("opening a record already on the trail cuts the trail back to it", () => {
  const t1 = rec("issue", "t1");
  const c1 = rec("check", "c1");
  const t2 = rec("issue", "t2");
  assert.deepEqual(viaTo([t1], c1, t2), [t1, c1]);
  assert.deepEqual(viaTo([t1], c1, t1), []);
  assert.deepEqual(viaTo([t1, c1], t2, c1), [t1]);
  // The same ID at another Site is another record.
  assert.deepEqual(viaTo([t1], c1, rec("issue", "t1", "s2")), [t1, c1]);
});

test("in the panel, only an Issue opened from a Check keeps that Check for its trail", () => {
  const c1 = rec("check", "c1");
  const t1 = rec("issue", "t1");
  assert.deepEqual(panelFrom(c1, t1), c1);
  assert.equal(panelFrom(t1, c1), null);
  assert.equal(panelFrom(t1, rec("issue", "t2")), null);
  assert.equal(panelFrom(null, t1), null);
});
