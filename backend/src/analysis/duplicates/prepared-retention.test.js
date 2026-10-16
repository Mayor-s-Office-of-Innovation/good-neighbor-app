import { expect, it } from "vitest";
import { preparedRetention } from "./prepared-retention.js";
it("never extends source retention by regenerating prepared image copies", () => {
  const uploaded = new Date("2026-09-01T00:00:00Z");
  expect(
    preparedRetention(uploaded, uploaded.getTime() + 26 * 86400000).cacheable,
  ).toBe(true);
  expect(
    preparedRetention(uploaded, uploaded.getTime() + 28 * 86400000),
  ).toMatchObject({ cacheable: false, expired: false });
  expect(
    preparedRetention(uploaded, uploaded.getTime() + 30 * 86400000),
  ).toMatchObject({ cacheable: false, expired: true });
  expect(preparedRetention(undefined)).toMatchObject({ cacheable: false });
});
