import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLASSIFIER_SERVICE_CODE_MAP,
} from "./sf311-classifier-service-code-map.js";
import {
  parseClassifierServiceCodeMap,
  parseServiceCodeOrAction,
  serviceCodesForClassifierLabels,
} from "./sf311-service-codes.js";

describe("SF311 service-code resolution", () => {
  it("distinguishes direct service codes from classifier commands", () => {
    expect(parseServiceCodeOrAction("1.1.4.7.20.0")).toEqual({
      kind: "service_code",
      serviceCode: "1.1.4.7.20.0",
    });
    expect(parseServiceCodeOrAction("Run bulky item analysis")).toEqual({
      kind: "classifier",
      classifierId: "bulky-items",
    });
    expect(parseServiceCodeOrAction("Run graffiti analysis")).toEqual({
      kind: "classifier",
      classifierId: "graffiti",
    });
  });

  it("maps classifier labels to unique service codes", () => {
    expect(
      serviceCodesForClassifierLabels({
        classifierId: "bulky-items",
        labels: ["Mattress", "Furniture"],
        map: {
          "bulky-items": {
            Mattress: "1.2.3",
            Furniture: "1.2.3",
          },
        },
      }),
    ).toEqual(["1.2.3"]);
  });

  it("uses built-in bulky item service-code mappings", () => {
    expect(
      serviceCodesForClassifierLabels({
        classifierId: "bulky-items",
        labels: [
          "Mattress",
          "Fridge/Appliance",
          "Contained Garbage",
          "Furniture",
        ],
      }),
    ).toEqual([
      "1.1.4.7.10.0",
      "1.1.4.7.16.0",
      "1.1.4.7.21.0",
      "1.1.4.7.7.0",
    ]);
  });

  it("uses built-in graffiti service-code mappings", () => {
    expect(
      serviceCodesForClassifierLabels({
        classifierId: "graffiti",
        labels: [
          "Graffiti - Offensive - Bike_Rack",
          "Graffiti - Not_Offensive - Sidewalk_In_Front_Of_Property",
        ],
      }),
    ).toEqual(["1.5.1.1.1.0", "1.5.2.2.4.0"]);
    expect(Object.keys(DEFAULT_CLASSIFIER_SERVICE_CODE_MAP.graffiti)).toHaveLength(
      42,
    );
  });

  it("rejects unmapped classifier labels", () => {
    expect(() =>
      serviceCodesForClassifierLabels({
        classifierId: "graffiti",
        labels: ["Unknown graffiti label"],
      }),
    ).toThrow("No SF311 service-code mapping");
  });

  it("merges a JSON classifier mapping from config over built-in data", () => {
    expect(
      parseClassifierServiceCodeMap(
        '{"graffiti":{"Graffiti - Not_Offensive - Other":"4.5.6"},"new-classifier":{"label":"7.8.9"}}',
      ),
    ).toMatchObject({
      "bulky-items": { Mattress: "1.1.4.7.10.0" },
      graffiti: { "Graffiti - Not_Offensive - Other": "4.5.6" },
      "new-classifier": { label: "7.8.9" },
    });
  });
});
