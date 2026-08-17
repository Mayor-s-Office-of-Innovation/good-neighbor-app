import { describe, expect, it } from "vitest";
import { downscaleImage } from "./downscale.js";

describe("downscaleImage (placeholder passthrough)", () => {
  it("returns the input bytes and content-type unchanged", async () => {
    const bytes = Buffer.from([1, 2, 3, 4]);
    const result = await downscaleImage(bytes, "image/jpeg");
    expect(result.bytes).toBe(bytes);
    expect(result.contentType).toBe("image/jpeg");
  });
});
