import { it, expect } from "vitest";
import { metadataMismatch } from "./candidate-priority.js";
/** @param {string} description @returns {import('./image-matcher.js').ImageObservation} */
const photo = (description) => ({
  id: description,
  revision: "1",
  image: { content_type: "image/jpeg", base64: "" },
  conditions: [{ id: "issue", category: "Litter", description }],
});
it("defers distinct object descriptions but abstains on vague, mixed and negated text", () => {
  expect(
    metadataMismatch(
      photo("A large pile of mattresses"),
      photo("Lots of litter scattered in a tree well"),
    ),
  ).toBe(true);
  expect(metadataMismatch(photo("some rubbish"), photo("a mattress"))).toBe(
    false,
  );
  expect(
    metadataMismatch(photo("mattresses and litter"), photo("a sofa")),
  ).toBe(false);
  expect(
    metadataMismatch(photo("no mattress is visible"), photo("a sofa")),
  ).toBe(false);
});
it("keeps multi-issue photos if any eligible pair could correspond", () => {
  const source = photo("mattress");
  source.conditions?.push({
    id: "second",
    category: "Litter",
    description: "litter",
  });
  expect(metadataMismatch(source, photo("litter"))).toBe(false);
});
