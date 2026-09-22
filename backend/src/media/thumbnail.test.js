import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
const { send, putObjectBytes, getObjectBytes } = vi.hoisted(() => ({
  send: vi.fn(),
  putObjectBytes: vi.fn(),
  getObjectBytes: vi.fn(),
}));
vi.mock("../db.js", () => ({ ddb: { send } }));
vi.mock("../s3.js", () => ({ putObjectBytes, getObjectBytes }));
import { createThumbnail, ensureThumbnail, thumbnailKey } from "./thumbnail.js";
const options = {
  dynamoTable: "table",
  uploadBucket: "bucket",
  key: { pk: "SITE#a", sk: "CHECK#c#ART#p#a" },
  s3Key: "checks/a/c/p/a",
};
const source = () =>
  sharp({
    create: {
      width: 2400,
      height: 1200,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .png()
    .toBuffer();
beforeEach(() => vi.resetAllMocks());

describe("thumbnail images", () => {
  it("bounds dimensions, flattens transparency, strips metadata and compresses", async () => {
    const bytes = await source();
    const thumb = await createThumbnail(bytes);
    const metadata = await sharp(thumb.bytes).metadata();
    expect(metadata).toMatchObject({ format: "jpeg", width: 400, height: 200 });
    expect(metadata.exif).toBeUndefined();
    expect(thumb.bytes.length).toBeLessThan(bytes.length);
    const { channels } = await sharp(thumb.bytes).stats();
    expect(channels[0].mean).toBeGreaterThan(250);
  });
  it("honors orientation and never enlarges", async () => {
    const bytes = await sharp({
      create: { width: 100, height: 50, channels: 3, background: "red" },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect(await createThumbnail(bytes)).toMatchObject({
      width: 50,
      height: 100,
    });
  });
  it("rejects corrupt images", async () => {
    await expect(createThumbnail(Buffer.from("invalid"))).rejects.toThrow();
  });
});

describe("thumbnail storage", () => {
  it("stores the derivative before conditionally publishing metadata", async () => {
    send
      .mockResolvedValueOnce({ Item: { s3Key: options.s3Key } })
      .mockResolvedValue({});
    await ensureThumbnail({ ...options, bytes: await source() });
    expect(putObjectBytes).toHaveBeenCalledWith(
      expect.objectContaining({
        key: thumbnailKey(options.s3Key),
        contentType: "image/jpeg",
      }),
    );
    expect(send.mock.calls[1][0].input).toMatchObject({
      ConditionExpression: "attribute_exists(sk) AND s3Key = :source",
      ExpressionAttributeValues: { ":thumbnail": { width: 400, height: 200 } },
    });
    expect(putObjectBytes.mock.invocationCallOrder[0]).toBeLessThan(
      send.mock.invocationCallOrder[1],
    );
  });
  it("does not publish metadata when storage fails; a later attempt can retry", async () => {
    send.mockResolvedValue({ Item: { s3Key: options.s3Key } });
    putObjectBytes.mockRejectedValueOnce(new Error("S3 unavailable"));
    const bytes = await source();
    await expect(ensureThumbnail({ ...options, bytes })).rejects.toThrow(
      "S3 unavailable",
    );
    expect(send).toHaveBeenCalledTimes(1);
    await ensureThumbnail({ ...options, bytes });
    expect(putObjectBytes).toHaveBeenCalledTimes(2);
  });
  it.each([
    undefined,
    { s3Key: "replacement" },
    { s3Key: options.s3Key, thumbnail: { s3Key: thumbnailKey(options.s3Key) } },
  ])("skips missing, replaced or already processed artifacts", async (Item) => {
    send.mockResolvedValue({ Item });
    await ensureThumbnail(options);
    expect(getObjectBytes).not.toHaveBeenCalled();
    expect(putObjectBytes).not.toHaveBeenCalled();
  });
});
