import { describe, expect, it } from "vitest";
import { taskMediaUrl } from "./task-media.js";

describe("task media", () => {
  it("uses the same hydrated media precedence for every task component", () => {
    expect(taskMediaUrl({ thumbnailUrl: "thumb", mediaUrl: "media" })).toBe(
      "thumb",
    );
    expect(taskMediaUrl({ photoUrl: "photo" })).toBe("photo");
    expect(taskMediaUrl({})).toBe("");
  });
});
