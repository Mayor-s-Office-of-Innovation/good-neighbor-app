import { beforeEach, expect, it, vi } from "vitest";
const {
  send,
  getObjectBytes,
  downscaleImage,
  storeThumbnail,
  recordThumbnail,
} = vi.hoisted(() => ({
  send: vi.fn(),
  getObjectBytes: vi.fn(),
  downscaleImage: vi.fn(),
  storeThumbnail: vi.fn(),
  recordThumbnail: vi.fn(),
}));
vi.mock("../db.js", () => ({ ddb: { send } }));
vi.mock("../s3.js", () => ({ getObjectBytes }));
vi.mock("../media/downscale.js", async (original) => ({
  ...(await original()),
  downscaleImage,
}));
vi.mock("../media/thumbnail.js", () => ({ storeThumbnail, recordThumbnail }));
const { handler } = await import("./update-media-thumbnail.js");
const media = {
  entityType: "task_update_media",
  s3Key: "checks/site/check/photo",
  contentType: "image/jpeg",
};
const event = {
  Records: [
    { body: JSON.stringify({ pk: "SITE#site", sk: "TASK#task#MEDIA#photo" }) },
  ],
};
const run = () =>
  handler(/** @type {any} */ (event), /** @type {any} */ ({}), () => {});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DYNAMO_TABLE", "table");
  vi.stubEnv("S3_UPLOAD_BUCKET", "uploads");
  vi.stubEnv("SQS_QUEUE_URL", "queue");
  send.mockResolvedValue({ Item: media });
  getObjectBytes.mockResolvedValue({
    bytes: Buffer.from("original"),
    contentType: "image/jpeg",
  });
  downscaleImage.mockResolvedValue({ bytes: Buffer.from("normalized") });
  storeThumbnail.mockResolvedValue("checks/site/check/photo.thumb.webp");
  recordThumbnail.mockResolvedValue({});
});
it("stores and records a thumbnail from the authoritative registration", async () => {
  await run();
  expect(storeThumbnail).toHaveBeenCalledWith({
    bucket: "uploads",
    s3Key: media.s3Key,
    bytes: Buffer.from("normalized"),
  });
  expect(recordThumbnail).toHaveBeenCalledWith({
    tableName: "table",
    key: { pk: "SITE#site", sk: "TASK#task#MEDIA#photo" },
    thumbS3Key: "checks/site/check/photo.thumb.webp",
  });
});
it.each([
  undefined,
  { ...media, thumbS3Key: "already-made" },
  { ...media, s3Key: "checks/another-site/photo" },
])("skips deleted, finished, or cross-site media: %j", async (row) => {
  send.mockResolvedValueOnce({ Item: row });
  await run();
  expect(getObjectBytes).not.toHaveBeenCalled();
});
it("retries transient S3 failures", async () => {
  getObjectBytes.mockRejectedValueOnce(new Error("temporary"));
  await expect(run()).rejects.toThrow("temporary");
  await run();
  expect(recordThumbnail).toHaveBeenCalledTimes(1);
});
it("acknowledges expired originals", async () => {
  getObjectBytes.mockRejectedValueOnce(
    Object.assign(new Error("expired"), { name: "NoSuchKey" }),
  );
  await run();
  expect(storeThumbnail).not.toHaveBeenCalled();
});
