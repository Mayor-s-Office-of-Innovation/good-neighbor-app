import { it, expect, vi } from "vitest";
import sharp from "sharp";
import { reusableImage } from "./prepared-cache.js";
it("reuses normalized bytes across evaluations and rejects corrupt cached bytes", async () => {
  const input = await sharp({
    create: { width: 32, height: 32, channels: 3, background: "#345678" },
  })
    .png()
    .toBuffer();
  /** @type {Map<string,Awaited<ReturnType<typeof import('./image-features.js').prepareImage>>>} */
  const cache = new Map();
  const load = vi.fn(async () => input);
  const options = {
    identity: "immutable-object",
    contentType: "image/png",
    load,
    read: async (/** @type {string} */ k) => cache.get(k),
    write: async (
      /** @type {string} */ k,
      /** @type {Awaited<ReturnType<typeof import('./image-features.js').prepareImage>>} */ value,
    ) => {
      cache.set(k, value);
    },
  };
  const first = await reusableImage(options),
    second = await reusableImage(options);
  expect(first.preparationCacheHit).toBe(false);
  expect(second.preparationCacheHit).toBe(true);
  expect(second.image).toEqual(first.image);
  expect(load).toHaveBeenCalledOnce();
  for (const [k, value] of cache)
    cache.set(k, { ...value, image: { ...value.image, base64: "corrupt" } });
  expect((await reusableImage(options)).preparationCacheHit).toBe(false);
  expect(load).toHaveBeenCalledTimes(2);
});
