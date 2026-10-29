import { describe, expect, it } from "vitest";
import {
  contentTypeFor,
  validPhotoAttachments,
  MAX_IMAGE_FILE,
  MAX_TOTAL,
} from "./attachment-files.js";

const photo = (size = 1, type = "image/jpeg", name = "photo.jpg") => ({
  size,
  type,
  name,
});

describe("attachment files", () => {
  it("uses MIME types and falls back to supported filename extensions", () => {
    expect(contentTypeFor(photo(1, "", "PHONE.HEIC"))).toBe("image/heic");
    expect(validPhotoAttachments([photo(1, "image/png", "capture")])).toBe(
      true,
    );
    expect(validPhotoAttachments([photo(1, "", "photo.heif")])).toBe(true);
    expect(
      validPhotoAttachments([photo(1, "application/pdf", "photo.jpg")]),
    ).toBe(false);
    expect(validPhotoAttachments([photo(1, "", "note.txt")])).toBe(false);
  });

  it("enforces count, nonempty photos, individual size, and total size", () => {
    expect(
      validPhotoAttachments(Array.from({ length: 5 }, () => photo())),
    ).toBe(true);
    expect(
      validPhotoAttachments(Array.from({ length: 6 }, () => photo())),
    ).toBe(false);
    expect(validPhotoAttachments([photo(0)])).toBe(false);
    expect(validPhotoAttachments([photo(MAX_IMAGE_FILE)])).toBe(true);
    expect(validPhotoAttachments([photo(MAX_IMAGE_FILE + 1)])).toBe(false);
    const remainder = MAX_TOTAL - 2 * MAX_IMAGE_FILE;
    expect(
      validPhotoAttachments([
        photo(MAX_IMAGE_FILE),
        photo(MAX_IMAGE_FILE),
        photo(remainder),
      ]),
    ).toBe(true);
    expect(
      validPhotoAttachments([
        photo(MAX_IMAGE_FILE),
        photo(MAX_IMAGE_FILE),
        photo(remainder + 1),
      ]),
    ).toBe(false);
  });
});
