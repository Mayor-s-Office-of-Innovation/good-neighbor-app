import { beforeEach, describe, expect, it, vi } from "vitest";
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));
vi.mock("../config.js", () => ({
  getDynamoTableName: () => "table",
  getConfig: () => ({ uploadBucket: "bucket" }),
}));
vi.mock("../s3.js", () => ({
  presignGet: vi.fn(async ({ key }) => `https://example.test/${key}`),
}));
import { getRecordPhotos } from "./record-photos.js";

/** @param {Record<string, string>} query @param {string} [role] */
const event = (query, role = "compliance-supervisor") =>
  /** @type {any} */ ({
    requestContext: {
      authorizer: { jwt: { claims: { "cognito:groups": role } } },
    },
    pathParameters: { siteId: "s1" },
    queryStringParameters: query,
  });
/** @param {any} ev */
const call = async (ev) => {
  const res = /** @type {any} */ (
    await getRecordPhotos(ev, /** @type {any} */ ({}), () => {})
  );
  return { status: res.statusCode, body: JSON.parse(res.body) };
};

/** @type {Record<string, any>} */
const rows = {
  "TASK#t1": {
    taskId: "t1",
    checkId: "c1",
    sourceArtifactIds: ["art-1"],
  },
  "CHECK#c1#ART#art-1": {
    artifactId: "art-1",
    s3Key: "p/check-1.jpg",
    thumbS3Key: "p/check-1-thumb.jpg",
    capturedAt: "2026-10-02T17:01:00.000Z",
  },
  "CHECK#c1#ART#art-2": {
    artifactId: "art-2",
    text: "Synthetic description",
    capturedAt: "2026-10-02T17:02:00.000Z",
  },
  "TASK#t1#MEDIA#t1-u2-p1": {
    artifactId: "t1-u2-p1",
    s3Key: "p/update-1.jpg",
    capturedAt: "2026-10-03T17:00:00.000Z",
  },
};
const updates = [
  {
    sk: "TASK#t1#UPDATE#2026-10-03T17:00:00.000Z#t1-u2",
    notes: ["Synthetic note"],
    photoKeys: ["t1-u2-p1"],
    occurredAt: "2026-10-03T17:00:00.000Z",
  },
  // A photo whose media row is gone still lets the rest show.
  {
    sk: "TASK#t1#UPDATE#2026-10-04T17:00:00.000Z#t1-u3",
    photoKeys: ["t1-u3-p1"],
    occurredAt: "2026-10-04T17:00:00.000Z",
  },
];

beforeEach(() => {
  send.mockReset();
  send.mockImplementation(async (/** @type {any} */ command) => {
    const input = command.input;
    if (input.Key) return { Item: rows[input.Key.sk] };
    const prefix = input.ExpressionAttributeValues[":prefix"];
    if (prefix === "CHECK#c1#ART#")
      return {
        Items: Object.entries(rows)
          .filter(([sk]) => sk.startsWith(prefix))
          .map(([, row]) => row),
      };
    if (prefix === "TASK#t1#UPDATE#") return { Items: updates };
    return { Items: [] };
  });
});

describe("getRecordPhotos", () => {
  it("refuses compliance managers before reading, as the admin's photo route does", async () => {
    const res = await call(event({ checkId: "c1" }, "compliance-manager"));
    expect(res.status).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  it("needs exactly one of a Check or an Issue", async () => {
    expect((await call(event({}))).status).toBe(400);
    expect((await call(event({ checkId: "c1", issueId: "t1" }))).status).toBe(
      400,
    );
  });

  it("gives a Check's photos with thumbnails, and its typed descriptions as notes", async () => {
    const { status, body } = await call(event({ checkId: "c1" }));
    expect(status).toBe(200);
    expect(body.photos).toEqual([
      expect.objectContaining({
        artifactId: "art-1",
        source: "check",
        url: "https://example.test/p/check-1.jpg",
        thumbnailUrl: "https://example.test/p/check-1-thumb.jpg",
      }),
    ]);
    expect(body.notes).toEqual([
      {
        source: "check",
        at: "2026-10-02T17:02:00.000Z",
        text: "Synthetic description",
      },
    ]);
  });

  it("gives an Issue's source photo first, then photos and notes staff added", async () => {
    const { body } = await call(event({ issueId: "t1" }));
    expect(
      body.photos.map((/** @type {any} */ p) => [p.artifactId, p.source]),
    ).toEqual([
      ["art-1", "check"],
      ["t1-u2-p1", "update"],
    ]);
    // No thumbnail stored, so the full photo stands in.
    expect(body.photos[1].thumbnailUrl).toBe(
      "https://example.test/p/update-1.jpg",
    );
    expect(body.notes).toEqual([
      {
        source: "update",
        at: "2026-10-03T17:00:00.000Z",
        text: "Synthetic note",
      },
    ]);
  });

  it("answers 404 for an Issue the Site doesn't have", async () => {
    expect((await call(event({ issueId: "nope" }))).status).toBe(404);
  });
});
