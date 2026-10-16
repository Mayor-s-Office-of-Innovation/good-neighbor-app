import { createHash } from "node:crypto";
import { prepareImage } from "./image-features.js";
export const PREPARATION_VERSION = "jpeg1200-q70-dhash-v1";
/** @typedef {Awaited<ReturnType<typeof prepareImage>>} Prepared */
/**
 * Separate immutable-media cache: no dependency from normal analysis.
 * @returns {Promise<Prepared & {preparationCacheHit:boolean}>}
 * @param {{identity:string,contentType:string,read:(key:string)=>Promise<Prepared|undefined>,write:(key:string,value:Prepared)=>Promise<void>,load:()=>Promise<Buffer>}} options
 */
export async function reusableImage({
  identity,
  contentType,
  read,
  write,
  load,
}) {
  const key = createHash("sha256")
    .update(`${PREPARATION_VERSION}:${identity}:${contentType}`)
    .digest("hex");
  const cached = await read(key);
  if (
    cached?.image?.content_type === "image/jpeg" &&
    typeof cached.image.base64 === "string" &&
    cached.image.base64.length > 0 &&
    Buffer.from(cached.image.base64, "base64").length <= 500000 &&
    cached.fingerprint ===
      createHash("sha256")
        .update(Buffer.from(cached.image.base64, "base64"))
        .digest("hex") &&
    /^[01]{64}$/.test(cached.perceptualHash)
  )
    return {
      image: cached.image,
      fingerprint: cached.fingerprint,
      perceptualHash: cached.perceptualHash,
      preparationCacheHit: true,
    };
  const bytes = await load();
  if (bytes.length > 10 * 1024 * 1024)
    throw new Error("Comparison image exceeds input limit");
  const prepared = await prepareImage(bytes, contentType);
  await write(key, prepared);
  return { ...prepared, preparationCacheHit: false };
}
