import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

const { ddbSend, putObject, setObjectTags } = vi.hoisted(() => ({
  ddbSend: vi.fn(),
  putObject: vi.fn(),
  setObjectTags: vi.fn(),
}));
vi.mock("../db.js", () => ({ ddb: { send: ddbSend } }));
vi.mock("../s3.js", () => ({ putObject, setObjectTags }));

const {
  makeThumbnail,
  recordThumbnail,
  storeThumbnail,
  thumbnailKeyFor,
  THUMBNAIL_EDGE_PX,
} = await import("./thumbnail.js");

/**
 * A flat JPEG of the given size, like a `downscaleImage` result.
 * @param {number} width @param {number} height
 */
const jpeg = (width, height) =>
  sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 40, g: 90, b: 160 },
    },
  })
    .jpeg()
    .toBuffer();

beforeEach(() => {
  ddbSend.mockReset().mockResolvedValue({});
  putObject.mockReset().mockResolvedValue({});
  setObjectTags.mockReset().mockResolvedValue({});
});

describe("makeThumbnail", () => {
  it("fits a landscape photo within the long-edge cap as WebP", async () => {
    const result = await makeThumbnail(await jpeg(1568, 1045));
    const meta = await sharp(result.bytes).metadata();
    expect(result.contentType).toBe("image/webp");
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(THUMBNAIL_EDGE_PX);
    expect(meta.height).toBeLessThanOrEqual(THUMBNAIL_EDGE_PX);
  });

  it("caps the long edge for portrait input", async () => {
    const result = await makeThumbnail(await jpeg(1045, 1568));
    const meta = await sharp(result.bytes).metadata();
    expect(meta.height).toBe(THUMBNAIL_EDGE_PX);
    expect(meta.width).toBeLessThan(THUMBNAIL_EDGE_PX);
  });

  it("never enlarges a small image", async () => {
    const result = await makeThumbnail(await jpeg(120, 90));
    const meta = await sharp(result.bytes).metadata();
    expect(meta.width).toBe(120);
    expect(meta.height).toBe(90);
  });

  it("is a fraction of the normalized photo's size", async () => {
    const source = await jpeg(1568, 1045);
    const result = await makeThumbnail(source);
    expect(result.bytes.length).toBeLessThan(source.length / 4);
  });
});

describe("storeThumbnail", () => {
  it("writes the WebP beside the original and tags it active", async () => {
    const key = await storeThumbnail({
      bucket: "bucket",
      s3Key: "checks/site-1/chk_01/art_1",
      bytes: await jpeg(600, 400),
    });
    expect(key).toBe("checks/site-1/chk_01/art_1.thumb.webp");
    expect(key).toBe(thumbnailKeyFor("checks/site-1/chk_01/art_1"));
    expect(putObject).toHaveBeenCalledTimes(1);
    expect(putObject.mock.calls[0][0]).toMatchObject({
      bucket: "bucket",
      key,
      contentType: "image/webp",
    });
    expect(putObject.mock.calls[0][0].body).toBeInstanceOf(Buffer);
    expect(setObjectTags).toHaveBeenCalledWith({
      bucket: "bucket",
      key,
      tags: { state: "active" },
    });
  });
});

describe("recordThumbnail", () => {
  it("sets thumbS3Key only on an existing row", async () => {
    await recordThumbnail({
      tableName: "t",
      key: { pk: "SITE#site-1", sk: "CHECK#chk_01#ART#art_1" },
      thumbS3Key: "checks/site-1/chk_01/art_1.thumb.webp",
    });
    const cmd = ddbSend.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(UpdateCommand);
    expect(cmd.input).toMatchObject({
      TableName: "t",
      Key: { pk: "SITE#site-1", sk: "CHECK#chk_01#ART#art_1" },
      UpdateExpression: "SET thumbS3Key = :k",
      ConditionExpression: "attribute_exists(sk)",
      ExpressionAttributeValues: {
        ":k": "checks/site-1/chk_01/art_1.thumb.webp",
      },
    });
  });
});
