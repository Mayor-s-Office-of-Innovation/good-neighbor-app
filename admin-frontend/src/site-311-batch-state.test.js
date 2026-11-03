import test from "node:test";
import assert from "node:assert/strict";
import {
  create311Batch,
  stage311,
  save311Batch,
  review311Draft,
} from "./site-311-batch-state.js";

const site = (siteId, enabled = true, version = "v1") => ({
  siteId,
  name: `Test ${siteId}`,
  sk: "#META",
  status: "active",
  deliberate311ProductionEnabled: enabled,
  updatedAt: version,
});

test("missing flag defaults to real delivery; reverting an edit removes its draft", () => {
  const batch = create311Batch();
  const record = { siteId: "one", updatedAt: "v1" };
  stage311(batch, record, false);
  assert.equal(batch.drafts.get("one").original, true);
  assert.equal(batch.drafts.get("one").enabled, false);
  stage311(batch, { ...record, updatedAt: "v2" }, true);
  assert.equal(batch.drafts.size, 0);
});

test("independent sequential writes retain failures and do not resend successes", async () => {
  const batch = create311Batch();
  for (const id of ["one", "two", "three"]) stage311(batch, site(id), false);
  const calls = [];
  const confirmed = [];
  let fail = true;
  const api = {
    getSite: async (id) => ({ items: [site(id)] }),
    updateSiteDeliberate311: async (id, values) => {
      calls.push(id);
      assert.deepEqual(values, {
        deliberate311ProductionEnabled: false,
        expectedUpdatedAt: "v1",
      });
      if (id === "two" && fail) throw new Error("network");
      return { site: site(id, false, "v2") };
    },
  };
  await save311Batch(batch, api, (s) => confirmed.push(s));
  assert.deepEqual(calls, ["one", "two", "three"]);
  assert.deepEqual([...batch.drafts.keys()], ["two"]);
  assert.equal(batch.saved, 2);
  fail = false;
  await save311Batch(batch, api, (s) => confirmed.push(s));
  assert.deepEqual(calls, ["one", "two", "three", "two"]);
  assert.equal(batch.drafts.size, 0);
});

test("uncertain successful writes are reconciled without another mutation", async () => {
  const batch = create311Batch();
  stage311(batch, site("one"), false);
  let writes = 0;
  const api = {
    updateSiteDeliberate311: async () => {
      writes++;
      throw new Error("lost response");
    },
    getSite: async () => ({ items: [site("one", false, "v2")] }),
  };
  await save311Batch(batch, api, () => {});
  assert.equal(writes, 1);
  assert.equal(batch.drafts.size, 0);
  assert.equal(batch.saved, 1);
});

test("changed records require explicit review and then use the latest version", async () => {
  const batch = create311Batch();
  stage311(batch, site("one"), false);
  let writes = 0;
  const api = {
    getSite: async () => ({ items: [site("one", true, "v2")] }),
    updateSiteDeliberate311: async (id, values) => {
      writes++;
      if (values.expectedUpdatedAt === "v1") throw new Error("site_changed");
      assert.equal(values.expectedUpdatedAt, "v2");
      return { site: site(id, false, "v3") };
    },
  };
  await save311Batch(batch, api, () => {});
  assert.equal(batch.drafts.get("one").error, "review");
  await save311Batch(batch, api, () => {});
  assert.equal(writes, 1);
  review311Draft(batch, "one");
  await save311Batch(batch, api, () => {});
  assert.equal(writes, 2);
  assert.equal(batch.drafts.size, 0);
});

test("failed read-back retains the draft and reconciles before retry", async () => {
  const batch = create311Batch();
  stage311(batch, site("one"), false);
  let readable = false;
  let writes = 0;
  const api = {
    getSite: async () => {
      if (!readable) throw new Error("offline");
      return { items: [site("one", false, "v2")] };
    },
    updateSiteDeliberate311: async () => {
      writes++;
      throw new Error("offline");
    },
  };
  await save311Batch(batch, api, () => {});
  assert.equal(batch.drafts.size, 1);
  readable = true;
  await save311Batch(batch, api, () => {});
  assert.equal(writes, 1);
  assert.equal(batch.drafts.size, 0);
});

test("a second save and checkbox edits are blocked while saving", async () => {
  const batch = create311Batch();
  stage311(batch, site("one"), false);
  const gate = Promise.withResolvers();
  let writes = 0;
  const api = {
    updateSiteDeliberate311: async () => {
      writes++;
      await gate.promise;
      return { site: site("one", false, "v2") };
    },
  };
  const pending = save311Batch(batch, api, () => {});
  stage311(batch, site("one"), true);
  await save311Batch(batch, api, () => {});
  assert.equal(batch.drafts.get("one").enabled, false);
  assert.equal(writes, 1);
  gate.resolve();
  await pending;
  assert.equal(batch.saving, false);
});
