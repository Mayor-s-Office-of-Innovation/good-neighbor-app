import { describe, expect, it } from "vitest";

import { orderedPhotoItems } from "./perimeter-check.templates.js";

describe("orderedPhotoItems", () => {
  it("renders captured photos newest-first after the add-photo tile", () => {
    expect(
      orderedPhotoItems([
        { id: "oldest", kind: "photo" },
        { id: "typed-note", kind: "text" },
        { id: "middle", kind: "photo" },
        { id: "newest", kind: "photo" },
      ]).map((item) => item.id),
    ).toEqual(["newest", "middle", "oldest"]);
  });
});
