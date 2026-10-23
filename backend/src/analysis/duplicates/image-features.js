import sharp from "sharp";
import { downscaleImage } from "../../media/downscale.js";
import { imageFingerprint } from "./image-matcher.js";

/**
 * @param {Buffer} input
 * @param {string} contentType
 * @returns {Promise<{image:{content_type:string,base64:string},fingerprint:string,perceptualHash:string}>}
 */
export async function prepareImage(input, contentType) {
  const normalized = await downscaleImage(input, contentType);
  const image = await sharp(normalized.bytes)
    .resize({
      width: 1200,
      height: 1200,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 70 })
    .toBuffer();
  if (image.length > 500000)
    throw new Error("Normalized comparison image exceeds byte limit");
  const pixels = await sharp(image)
    .resize(9, 8, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer();
  let hash = "";
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++)
      hash += pixels[y * 9 + x] > pixels[y * 9 + x + 1] ? "1" : "0";
  return {
    image: { content_type: "image/jpeg", base64: image.toString("base64") },
    fingerprint: imageFingerprint(image),
    perceptualHash: hash,
  };
}
