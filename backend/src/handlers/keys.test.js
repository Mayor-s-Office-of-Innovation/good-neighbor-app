import { describe, expect, it } from "vitest";
import {
  analysisKey,
  artifactKey,
  checkChildrenPrefix,
  checkHeaderKey,
  checkTimelineGsi,
  sitePk,
  taskKey,
  taskWorklistGsi,
} from "./keys.js";

describe("single-table key builders", () => {
  it("shares one tenant partition across item types", () => {
    expect(sitePk("s1")).toBe("SITE#s1");
    expect(checkHeaderKey("s1", "c1").pk).toBe("SITE#s1");
    expect(artifactKey("s1", "c1", "north", "a1").pk).toBe("SITE#s1");
    expect(taskKey("s1", "t1").pk).toBe("SITE#s1");
  });

  it("nests a check's children under its CHECK# prefix", () => {
    const prefix = checkChildrenPrefix("c1");
    expect(prefix).toBe("CHECK#c1");
    expect(checkHeaderKey("s1", "c1").sk).toBe("CHECK#c1");
    expect(artifactKey("s1", "c1", "north", "a1").sk).toBe(
      "CHECK#c1#ART#north#a1",
    );
    expect(analysisKey("s1", "c1", "a1").sk).toBe("CHECK#c1#ANALYSIS#a1");
    // Every child begins with the header's prefix — that's what makes AP7 one query.
    for (const sk of [
      artifactKey("s1", "c1", "north", "a1").sk,
      analysisKey("s1", "c1", "a1").sk,
    ]) {
      expect(sk.startsWith(prefix)).toBe(true);
    }
  });

  it("builds task keys and worklist GSI attributes", () => {
    expect(taskKey("s1", "t1").sk).toBe("TASK#t1");
    expect(
      taskWorklistGsi("s1", "open", 4, "2026-08-14T00:00:00.000Z"),
    ).toEqual({
      gsi2pk: "SITE#s1#TASK#open",
      gsi2sk: "4#2026-08-14T00:00:00.000Z",
    });
  });

  it("builds the checks-timeline GSI attributes", () => {
    expect(checkTimelineGsi("s1", "2026-08-14T00:00:00.000Z")).toEqual({
      gsi1pk: "SITE#s1",
      gsi1sk: "2026-08-14T00:00:00.000Z",
    });
  });
});
