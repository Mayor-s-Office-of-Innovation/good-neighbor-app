import { expect, it } from "vitest";
import { visibleDuplicateState } from "./result-state.js";
it("bounds pending presentation without turning failures into negative matches", () => {
  const now = Date.now();
  expect(
    visibleDuplicateState("pending", new Date(now - 899999).toISOString(), now),
  ).toBe("pending");
  expect(
    visibleDuplicateState("pending", new Date(now - 900000).toISOString(), now),
  ).toBe("unavailable");
  expect(visibleDuplicateState("pending", undefined, now)).toBe("unavailable");
  expect(visibleDuplicateState("matched", undefined, now)).toBe("matched");
  expect(visibleDuplicateState("complete", undefined, now)).toBe("complete");
});
