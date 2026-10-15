import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  headObject: vi.fn(),
  getObjectBytes: vi.fn(),
  presignGet: vi.fn(),
  presignPut: vi.fn(),
  putObject: vi.fn(),
  setObjectTags: vi.fn(),
  downscaleImage: vi.fn(),
}));
vi.mock("../db.js", () => ({ ddb: { send: mocks.send } }));
vi.mock("../s3.js", () => mocks);
vi.mock("../media/downscale.js", () => ({
  downscaleImage: mocks.downscaleImage,
  DownscaleError: class extends Error {},
}));
import {
  createCareWork,
  listCareWork,
  getCareWork,
  getCarePhoto,
  presignCarePhoto,
} from "./care-work.js";
const ID = "11111111-1111-4111-8111-111111111111";
const PHOTO = "22222222-2222-4222-8222-222222222222";
const NOW = Math.floor(new Date("2026-10-16T12:00:00Z").getTime() / 1000);
/** @param {any} [body] @param {string} [site] @param {string} [actor] @returns {any} */
function event(body, site = "site-a", actor = "device-a") {
  return {
    body: JSON.stringify(body),
    pathParameters: { workId: ID, photoId: PHOTO },
    requestContext: {
      authorizer: { jwt: { claims: { "custom:siteId": site, sub: actor } } },
    },
  };
}
const payload = () => ({
  workId: ID,
  kind: "power_washed",
  note: "",
  photoIds: [],
});
/** @type {Map<string, any>} */
let records;
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
  vi.stubEnv("DYNAMO_TABLE", "test");
  vi.stubEnv("S3_UPLOAD_BUCKET", "uploads");
  vi.stubEnv("SQS_QUEUE_URL", "queue");
  records = new Map();
  mocks.send.mockImplementation(async (command) => {
    if (command instanceof GetCommand)
      return {
        Item: records.get(`${command.input.Key?.pk}/${command.input.Key?.sk}`),
      };
    if (command instanceof QueryCommand) return { Items: [] };
    if (command instanceof TransactWriteCommand) {
      for (const op of command.input.TransactItems || [])
        if (op.Put?.Item)
          records.set(`${op.Put.Item.pk}/${op.Put.Item.sk}`, op.Put.Item);
    }
    return {};
  });
  mocks.presignPut.mockResolvedValue("https://upload.test");
  mocks.presignGet.mockResolvedValue("https://download.test");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
describe("Site-scoped proactive care", () => {
  it("logs a fixed option without evidence for a year and returns the same record on replay", async () => {
    const first = await createCareWork(event(payload()));
    expect(first.statusCode).toBe(201);
    const item = records.get(`SITE#site-a/CARE_WORK#${ID}`);
    expect(item).toMatchObject({
      type: "careWork",
      expiresAt: NOW + 365 * 86400,
      photos: [],
      gsi1pk: "SITE#site-a#CARE_WORK",
    });
    expect(item).not.toHaveProperty("checkId");
    expect(item).not.toHaveProperty("taskId");
    expect((await createCareWork(event(payload()))).body).toBe(first.body);
    expect(
      mocks.send.mock.calls.filter(
        ([command]) => command instanceof TransactWriteCommand,
      ),
    ).toHaveLength(1);
    expect(mocks.putObject).not.toHaveBeenCalled();
  });
  it("requires custom text, validates kinds and photo counts, and rejects invalid JSON", async () => {
    for (const body of [
      { ...payload(), kind: "other", note: "  " },
      { ...payload(), kind: "unknown" },
      { ...payload(), note: "x".repeat(4001) },
      { ...payload(), photoIds: [PHOTO, PHOTO] },
      { ...payload(), photoIds: Array(6).fill(PHOTO) },
    ])
      expect((await createCareWork(event(body))).statusCode).toBe(400);
    expect((await createCareWork({ ...event(), body: "{" })).statusCode).toBe(
      400,
    );
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("never edits an existing log and shares it with other devices at the same Site", async () => {
    await createCareWork(
      event({ ...payload(), kind: "other", note: "Swept the steps" }),
    );
    expect(
      (await createCareWork(event({ ...payload(), note: "changed" })))
        .statusCode,
    ).toBe(409);
    expect(
      (await getCareWork(event(undefined, "site-a", "device-b"))).statusCode,
    ).toBe(200);
    expect((await getCareWork(event(undefined, "site-b"))).statusCode).toBe(
      404,
    );
  });
  it("filters expired records before asynchronous TTL deletion", async () => {
    await createCareWork(event(payload()));
    vi.setSystemTime((NOW + 365 * 86400 + 1) * 1000);
    expect((await getCareWork(event())).statusCode).toBe(404);
    expect((await createCareWork(event(payload()))).statusCode).toBe(410);
    await listCareWork(event());
    const query = mocks.send.mock.calls.find(
      ([command]) => command instanceof QueryCommand,
    )?.[0];
    expect(query.input.FilterExpression).toBe("expiresAt > :now");
  });
  it("bounds pagination and refuses a cursor from another tenant", async () => {
    const token = Buffer.from(
      JSON.stringify({
        pk: "SITE#site-b",
        sk: `CARE_WORK#${ID}`,
        gsi1pk: "SITE#site-b#CARE_WORK",
        gsi1sk: "now",
      }),
    ).toString("base64url");
    expect(
      (
        await listCareWork({
          ...event(),
          queryStringParameters: { nextToken: token },
        })
      ).statusCode,
    ).toBe(400);
    await listCareWork(event());
    expect(mocks.send.mock.calls.at(-1)?.[0].input).toMatchObject({
      Limit: 50,
      ScanIndexForward: false,
      ExpressionAttributeValues: { ":pk": "SITE#site-a#CARE_WORK" },
    });
  });
  it("reserves quotas before signing a Site-prefixed, pending, no-overwrite upload", async () => {
    expect(
      (
        await presignCarePhoto(
          event({ contentType: "image/jpeg", contentLength: 12 }),
        )
      ).statusCode,
    ).toBe(200);
    expect(mocks.send.mock.calls[0][0].input.TransactItems).toHaveLength(6);
    expect(mocks.presignPut).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: "uploads",
        key: expect.stringMatching(/^care-work\/site-a\//),
        tagging: "state=pending",
        contentLength: 12,
      }),
    );
    expect(
      (
        await presignCarePhoto(
          event({ contentType: "image/svg+xml", contentLength: 12 }),
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await presignCarePhoto(
          event({ contentType: "image/jpeg", contentLength: 11 * 1024 * 1024 }),
        )
      ).statusCode,
    ).toBe(400);
  });
  it("renews an owned upload URL without reserving quota twice", async () => {
    const body = {
      photoId: PHOTO,
      contentType: "image/jpeg",
      contentLength: 3,
    };
    records.set(`SITE#site-a/CARE_UPLOAD#${ID}#${PHOTO}`, {
      createdBy: "device-a",
      contentLength: 3,
      contentType: "image/jpeg",
      createdAt: NOW,
      expiresAt: NOW + 86400,
    });
    expect((await presignCarePhoto(event(body))).statusCode).toBe(200);
    expect(
      mocks.send.mock.calls.every(([command]) => command instanceof GetCommand),
    ).toBe(true);
    expect(
      (await presignCarePhoto(event(body, "site-a", "device-b"))).statusCode,
    ).toBe(409);
    expect(
      (await presignCarePhoto(event({ ...body, contentLength: 4 }))).statusCode,
    ).toBe(409);
    expect(mocks.presignPut).toHaveBeenCalledTimes(1);
  });
  it("does not sign when reservation quotas fail", async () => {
    mocks.send.mockRejectedValue(
      Object.assign(new Error(), { name: "TransactionCanceledException" }),
    );
    expect(
      (
        await presignCarePhoto(
          event({ contentType: "image/jpeg", contentLength: 12 }),
        )
      ).statusCode,
    ).toBe(409);
    expect(mocks.presignPut).not.toHaveBeenCalled();
  });
  it("validates and strips photo metadata into a separate 30-day key without analysis", async () => {
    records.set(`SITE#site-a/CARE_UPLOAD#${ID}#${PHOTO}`, {
      createdBy: "device-a",
      contentLength: 3,
      contentType: "image/jpeg",
      createdAt: NOW,
      expiresAt: NOW + 86400,
    });
    mocks.headObject.mockResolvedValue({
      contentType: "image/jpeg",
      contentLength: 3,
      metadata: { "declared-bytes": "3" },
    });
    mocks.getObjectBytes.mockResolvedValue({ bytes: Buffer.from("raw") });
    mocks.downscaleImage.mockResolvedValue({
      bytes: Buffer.from("normalized"),
      contentType: "image/jpeg",
    });
    expect(
      (await createCareWork(event({ ...payload(), photoIds: [PHOTO] })))
        .statusCode,
    ).toBe(201);
    const key = `care-work/site-a/${ID}/${PHOTO}.jpg`;
    expect(mocks.putObject).toHaveBeenCalledWith({
      bucket: "uploads",
      key,
      body: Buffer.from("normalized"),
      contentType: "image/jpeg",
    });
    expect(mocks.setObjectTags).toHaveBeenCalledWith({
      bucket: "uploads",
      key,
      tags: { state: "active" },
    });
    const saved = records.get(`SITE#site-a/CARE_WORK#${ID}`);
    expect(saved.photos[0].expiresAt).toBe(NOW + 30 * 86400);
    expect((await getCarePhoto(event())).statusCode).toBe(200);
    vi.setSystemTime((NOW + 30 * 86400) * 1000);
    expect((await getCarePhoto(event())).statusCode).toBe(410);
    expect((await getCareWork(event())).statusCode).toBe(200);
    expect(mocks.presignGet).toHaveBeenCalledTimes(1);
  });
  it("rejects another device's reservation and unsigned size metadata", async () => {
    records.set(`SITE#site-a/CARE_UPLOAD#${ID}#${PHOTO}`, {
      createdBy: "device-b",
      contentLength: 3,
      contentType: "image/jpeg",
      createdAt: NOW,
      expiresAt: NOW + 86400,
    });
    expect(
      (await createCareWork(event({ ...payload(), photoIds: [PHOTO] })))
        .statusCode,
    ).toBe(400);
    expect(mocks.headObject).not.toHaveBeenCalled();
    records.get(`SITE#site-a/CARE_UPLOAD#${ID}#${PHOTO}`).createdBy =
      "device-a";
    mocks.headObject.mockResolvedValue({
      contentType: "image/jpeg",
      contentLength: 3,
    });
    expect(
      (await createCareWork(event({ ...payload(), photoIds: [PHOTO] })))
        .statusCode,
    ).toBe(400);
    expect(mocks.getObjectBytes).not.toHaveBeenCalled();
  });
  it("refuses corrupted stored media pointers to other paths", async () => {
    await createCareWork(event(payload()));
    records.get(`SITE#site-a/CARE_WORK#${ID}`).photos = [
      { photoId: PHOTO, s3Key: "checks/other/private", expiresAt: NOW + 1000 },
    ];
    expect((await getCarePhoto(event())).statusCode).toBe(404);
    expect(mocks.presignGet).not.toHaveBeenCalled();
  });
});
