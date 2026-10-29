import { describe, expect, it } from "vitest";
import {
  analysisKey,
  assessmentConditionPrefix,
  assessmentKey,
  assessmentTimelineGsi,
  artifactKey,
  checkChildrenPrefix,
  checkHeaderKey,
  checkTimelineGsi,
  COMPLIANCE_TERMS_OPEN_PK,
  complianceTermsExpiryGsi,
  conditionKey,
  GSI3_NAME,
  sitePk,
  taskKey,
  taskWorklistDateGsi,
} from "./keys.js";

describe("single-table key builders", () => {
  it("shares one tenant partition across item types", () => {
    expect(sitePk("s1")).toBe("SITE#s1");
    expect(checkHeaderKey("s1", "c1").pk).toBe("SITE#s1");
    expect(artifactKey("s1", "c1", "a1").pk).toBe("SITE#s1");
    expect(taskKey("s1", "t1").pk).toBe("SITE#s1");
  });

  it("nests a check's children under its CHECK# prefix", () => {
    const prefix = checkChildrenPrefix("c1");
    expect(prefix).toBe("CHECK#c1");
    expect(checkHeaderKey("s1", "c1").sk).toBe("CHECK#c1");
    expect(artifactKey("s1", "c1", "a1").sk).toBe("CHECK#c1#ART#a1");
    expect(analysisKey("s1", "c1", "a1").sk).toBe("CHECK#c1#ANALYSIS#a1");
    // Every child begins with the header's prefix — that's what makes AP7 one query.
    for (const sk of [
      artifactKey("s1", "c1", "a1").sk,
      analysisKey("s1", "c1", "a1").sk,
    ]) {
      expect(sk.startsWith(prefix)).toBe(true);
    }
  });

  it("builds task keys", () => {
    expect(taskKey("s1", "t1").sk).toBe("TASK#t1");
  });

  it("builds the checks-timeline GSI attributes", () => {
    expect(checkTimelineGsi("s1", "2026-08-14T00:00:00.000Z")).toEqual({
      gsi1pk: "SITE#s1",
      gsi1sk: "2026-08-14T00:00:00.000Z",
    });
  });

  it("builds assessment and condition keys", () => {
    expect(assessmentKey("s1", "asm1")).toEqual({
      pk: "SITE#s1",
      sk: "ASSESSMENT#asm1",
    });
    expect(conditionKey("s1", "asm1", "cond1")).toEqual({
      pk: "SITE#s1",
      sk: "ASSESSMENT#asm1#COND#cond1",
    });
    expect(assessmentConditionPrefix("asm1")).toBe("ASSESSMENT#asm1#COND#");
  });

  it("builds the sparse GSI3 expiry key for an end-dated compliance terms version", () => {
    expect(GSI3_NAME).toBe("GSI3");
    expect(COMPLIANCE_TERMS_OPEN_PK).toBe("COMPLIANCE_TERMS#OPEN");
    expect(complianceTermsExpiryGsi("s1", "2026-12-02", "v1")).toEqual({
      gsi3pk: "COMPLIANCE_TERMS#OPEN",
      gsi3sk: "2026-12-02#s1#v1",
    });
  });

  it("builds assessment and date-first task GSIs", () => {
    expect(
      assessmentTimelineGsi("s1", "2026-08-18T00:00:00.000Z", "asm1"),
    ).toEqual({
      gsi1pk: "SITE#s1#ASSESSMENT",
      gsi1sk: "2026-08-18T00:00:00.000Z#asm1",
    });
    expect(
      taskWorklistDateGsi(
        "s1",
        "open",
        "escalation",
        4,
        "2026-08-18T00:00:00.000Z",
        "task1",
      ),
    ).toEqual({
      gsi2pk: "SITE#s1#TASK#open",
      gsi2sk: "2026-08-18T00:00:00.000Z#escalation#4#task1",
    });
  });
});
