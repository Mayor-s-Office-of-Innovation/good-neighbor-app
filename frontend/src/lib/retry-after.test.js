import { expect, it } from "vitest";
import { parseRetryAfter } from "./retry-after.js";
const now = Date.parse("2026-10-28T12:00:00Z");
it.each([
  ["300", 300000],
  ["0", 0],
  [" 15 ", 15000],
  ["Wed, 28 Oct 2026 12:05:00 GMT", 300000],
  ["Wed, 28 Oct 2026 11:00:00 GMT", 0],
  [null, undefined],
  [undefined, undefined],
  ["", undefined],
  ["-1", undefined],
  ["1.5", undefined],
  ["soon", undefined],
  ["Infinity", undefined],
  ["99999999999999999999999", undefined],
])("normalizes %s as %s without starting retries", (value, expected) => {
  expect(parseRetryAfter(value, now)).toBe(expected);
});
