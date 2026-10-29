import { createRequire } from "node:module";
import { getObjectBytes, putObject } from "../s3.js";

const require = createRequire(import.meta.url);

export class InvalidTaskPhoto extends Error {}

/** Decode only on HEIC uploads; the codec never enters the browser bundle. */
async function codec() {
  return require("libheif-js/wasm-bundle.js");
}

/** @param {Buffer} bytes @returns {Promise<Buffer>} */
export async function heicDisplayImage(bytes) {
  if (!bytes.length || bytes.length > 10 * 1024 * 1024)
    throw new InvalidTaskPhoto("Invalid image size");
  const lib = await codec();
  const { default: sharp } = await import("sharp");
  const decoder = new lib.HeifDecoder();
  /** @type {Array<{is_primary(): boolean, get_width(): number, get_height(): number, display(target: {data: Uint8ClampedArray, width: number, height: number}, callback: (result: {data: Uint8ClampedArray} | null) => void): void, free(): void}>} */
  let images = [];
  try {
    images = decoder.decode(bytes);
    // A phone photo may include auxiliary images; select its primary image.
    const image = images.find((item) => item.is_primary()) || images[0];
    if (!image) throw new InvalidTaskPhoto("Invalid HEIC image");
    const width = image.get_width();
    const height = image.get_height();
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      width > 12000 ||
      height > 12000 ||
      width * height > 40_000_000
    )
      throw new InvalidTaskPhoto("Image dimensions exceed policy");
    const rgba = await new Promise((resolve, reject) => {
      image.display(
        { data: new Uint8ClampedArray(width * height * 4), width, height },
        (result) => {
          if (result) resolve(result.data);
          else reject(new InvalidTaskPhoto("Cannot decode HEIC image"));
        },
      );
    });
    // libheif applies HEIF orientation transforms during decode.
    return await sharp(Buffer.from(rgba), {
      raw: { width, height, channels: 4 },
    })
      .flatten({ background: "white" })
      .resize({
        width: 2048,
        height: 2048,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch (error) {
    if (error instanceof InvalidTaskPhoto) throw error;
    throw new InvalidTaskPhoto("Cannot decode HEIC image");
  } finally {
    for (const image of images) image.free();
    if (decoder.decoder) lib.heif_context_free(decoder.decoder);
  }
}

/** Preserve the upload, storing a displayable JPEG beside it under the same retention policy.
 * @param {{bucket: string, key: string, contentType: string, contentLength: number}} input
 * @returns {Promise<string | undefined>}
 */
export async function storeTaskPhotoDisplay({
  bucket,
  key,
  contentType,
  contentLength,
}) {
  if (!["image/heic", "image/heif"].includes(contentType)) return undefined;
  const object = await getObjectBytes({ bucket, key });
  if (
    object.bytes.length !== contentLength ||
    object.contentType !== contentType
  )
    throw new InvalidTaskPhoto("Upload changed during registration");
  const body = await heicDisplayImage(object.bytes);
  const displayS3Key = `${key}.display.jpg`;
  await putObject({
    bucket,
    key: displayS3Key,
    body,
    contentType: "image/jpeg",
    tagging: "state=registered",
  });
  return displayS3Key;
}
