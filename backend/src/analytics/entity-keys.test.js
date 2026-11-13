import { describe, expect, it } from "vitest";
import { classifyItem } from "./entity-keys.js";

describe("reporting key shapes", () => {
  it.each([
    ["CHECK#old-check-id", "checks"],
    ["CHECK#c1#ART#a1", "artifacts"],
    ["CHECK#c1#ART#old-place#a1", "artifacts"],
    ["CHECK#c1#ANALYSIS#a1", "analyses"],
    ["ASSESSMENT#check-artifact-revision", "assessments"],
    ["ASSESSMENT#as1#COND#001-litter", "conditions"],
    ["ASSESSMENT#as1#COND#c1#extra", "conditions"],
    ["ASSESSMENT#as1#COND##", "conditions"],
    ["ASSESSMENT#as1#COND#c1\n#extra", "conditions"],
    ["TASK#t1", "tasks"],
    ["TASK#t1#UPDATE#2026-10-28T00:00:00.000Z#u1", "task_updates"],
    ["DUP_LINK#t2", "duplicate_links"],
    ['DUP_OVERRIDE#["c1","a1","k1"]', "duplicate_overrides"],
    ["DEVICE#d1", "devices"],
    ["#META", "sites"],
  ])("recognizes %s without requiring UUID IDs", (sk, entity) => {
    expect(classifyItem({ pk: "SITE#s1", sk })).toBe(entity);
  });

  it.each([
    "TASK#t1#UPDATE#2026-10-28T00:00:00.000Z",
    "TASK#t1#UPDATE#2026-10-28T00:00:00.000Z#u1#extra",
    "TASK#t1#UPDATE_ID#u1",
    "DUP_LINK#",
    "DUP_LINK#t1#extra",
    "DUP_OVERRIDE#",
    "TASK#t1#MEDIA#a1",
    "TASK#t1#FUTURE#x",
    "CHECK#c1#UPDATE_MEDIA#a1",
    "CHECK#c1#FUTURE#x",
    "CHECK#c1#FUTURE#ART#a1",
    "CHECK#c1#ART#place#a1#extra",
    "CHECK#c1#ANALYSIS#a1#extra",
    "ASSESSMENT#as1#FUTURE#x",
    "ASSESSMENT#as1#FUTURE#COND#c1",
    "DEVICE#d1#SESSION#s1",
    "CHECK_COMPLETION#2026-10-28#timestamp#c1",
    "COMPLAINT#c1",
    "CARE_WORK#w1",
    "CHECK#",
    "CHECK##ART#a1",
    "CHECK#c1#ART#",
    "TASK#",
    "ASSESSMENT#as1#COND#",
    "DEVICE#",
  ])("skips unsupported or malformed key %s", (sk) => {
    expect(classifyItem({ pk: "SITE#s1", sk })).toBeNull();
  });

  it("requires the correct complete partition and string keys", () => {
    expect(classifyItem({ pk: "PROVIDER#p1", sk: "#META" })).toBe("providers");
    expect(classifyItem({ pk: "PROGRAM#p1", sk: "#META" })).toBe("programs");
    expect(classifyItem({ pk: "PROGRAM#p1", sk: "USER#u1" })).toBeNull();
    for (const pk of [
      "SITE#",
      "SITE#s1#CHILD",
      "PROVIDER#p1",
      "OTHER#s1",
      null,
    ]) {
      expect(classifyItem({ pk, sk: "CHECK#c1" })).toBeNull();
    }
    expect(classifyItem({ pk: "PROVIDER#p1#CHILD", sk: "#META" })).toBeNull();
    expect(classifyItem({ pk: "SITE#s1" })).toBeNull();
    expect(classifyItem({ pk: "SITE#s1", sk: 123 })).toBeNull();
  });
});
