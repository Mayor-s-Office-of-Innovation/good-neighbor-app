import { beforeEach, expect, it, vi } from "vitest";
vi.mock("../db.js", () => ({ ddb: { send: vi.fn() } }));
vi.mock("../config.js", () => ({ getDynamoTableName: () => "test" }));
import { ddb } from "../db.js";
import { perimeterAttribution } from "./perimeter-attribution.js";
beforeEach(() => vi.clearAllMocks());
it("resolves a legacy app actor using only the Site's device record", async () => {
  /** @type {any} */ (ddb.send).mockResolvedValue({
    Item: { label: "Test phone" },
  });
  expect(
    await perimeterAttribution({ perimeterUpdatedBy: "device-1" }, "site-1"),
  ).toEqual({
    perimeterUpdatedSource: "good-neighbor",
    perimeterUpdatedDeviceLabel: "Test phone",
  });
  expect(/** @type {any} */ (ddb.send).mock.calls[0][0].input.Key).toEqual({
    pk: "SITE#site-1",
    sk: "DEVICE#device-1",
  });
});
it("retains app attribution after device removal", async () => {
  /** @type {any} */ (ddb.send).mockResolvedValue({});
  expect(
    await perimeterAttribution(
      {
        perimeterUpdatedBy: "device-1",
        perimeterUpdatedSource: "good-neighbor",
      },
      "site-1",
    ),
  ).toEqual({
    perimeterUpdatedSource: "good-neighbor",
    perimeterUpdatedDeviceLabel: "",
  });
});
it("does not label dashboard editors as app users", async () => {
  /** @type {any} */ (ddb.send).mockResolvedValue({});
  expect(
    await perimeterAttribution({ perimeterUpdatedBy: "admin-1" }, "site-1"),
  ).toEqual({});
});
