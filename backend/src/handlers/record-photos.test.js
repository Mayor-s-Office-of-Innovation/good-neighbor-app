import { URLSearchParams } from "node:url";
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
import { recordPhotosReply } from "../../../e2e/admin-tests/insights-mock.js";

/**
 * @param {Record<string, string>} query
 * @param {{ role?: string, siteId?: string }} [opts]
 */
const event = (query, { role = "compliance-supervisor", siteId = "s1" } = {}) =>
  /** @type {any} */ ({
    requestContext: {
      authorizer: { jwt: { claims: { "cognito:groups": role } } },
    },
    pathParameters: { siteId },
    queryStringParameters: query,
  });
/** @param {any} ev */
const call = async (ev) => {
  const res = /** @type {any} */ (
    await getRecordPhotos(ev, /** @type {any} */ ({}), () => {})
  );
  return { status: res.statusCode, body: JSON.parse(res.body) };
};

const S1 = "checks/s1/c1";

/** @returns {Map<string, Record<string, any>>} rows by `pk|sk` */
const table = () =>
  new Map(
    /** @type {[string, string, Record<string, any>][]} */ ([
      ["SITE#s1", "CHECK#c1", { checkId: "c1" }],
      [
        "SITE#s1",
        "CHECK#c1#ART#art-1",
        {
          artifactId: "art-1",
          s3Key: `${S1}/art-1`,
          thumbS3Key: `${S1}/art-1.thumb.webp`,
          capturedAt: "2026-10-02T17:01:00.000Z",
        },
      ],
      [
        "SITE#s1",
        "CHECK#c1#ART#art-2",
        {
          artifactId: "art-2",
          text: "Synthetic description",
          capturedAt: "2026-10-02T17:02:00.000Z",
        },
      ],
      [
        "SITE#s1",
        "TASK#t1",
        {
          taskId: "t1",
          checkId: "c1",
          sourceArtifactIds: ["art-1"],
          assessmentId: "a1",
          conditionId: "k1",
        },
      ],
      [
        "SITE#s1",
        "TASK#t1#UPDATE#2026-10-03T17:00:00.000Z#u2",
        {
          notes: ["Synthetic note"],
          photoKeys: ["t1-u2-p1"],
          occurredAt: "2026-10-03T17:00:00.000Z",
        },
      ],
      // A photo whose media row is gone still lets the rest show.
      [
        "SITE#s1",
        "TASK#t1#UPDATE#2026-10-04T18:00:00.000Z#u3",
        { photoKeys: ["t1-u3-p1"], occurredAt: "2026-10-04T18:00:00.000Z" },
      ],
      [
        "SITE#s1",
        "TASK#t1#MEDIA#t1-u2-p1",
        {
          artifactId: "t1-u2-p1",
          s3Key: `${S1}/t1-u2-p1`,
          displayS3Key: `${S1}/t1-u2-p1.display.jpg`,
          capturedAt: "2026-10-05T17:00:00.000Z",
        },
      ],
      // Its follow-up task, on the same condition.
      ["SITE#s1", "ASSESSMENT#a1#COND#k1", { taskIds: ["t1", "t4", "t5"] }],
      [
        "SITE#s1",
        "TASK#t4",
        {
          taskId: "t4",
          checkId: "c1",
          sourceArtifactIds: ["art-1"],
          assessmentId: "a1",
          conditionId: "k1",
          status: "in_progress",
        },
      ],
      [
        "SITE#s1",
        "TASK#t4#UPDATE#2026-10-04T17:00:00.000Z#u1",
        {
          type: "additional_action",
          text: "Synthetic action",
          photoKeys: ["t4-u1-p1"],
          occurredAt: "2026-10-04T17:00:00.000Z",
        },
      ],
      [
        "SITE#s1",
        "TASK#t4#MEDIA#t4-u1-p1",
        {
          artifactId: "t4-u1-p1",
          s3Key: `${S1}/t4-u1-p1`,
          capturedAt: "2026-10-04T17:00:00.000Z",
        },
      ],
      // Uploaded but never saved with an update.
      [
        "SITE#s1",
        "TASK#t4#MEDIA#t4-stray",
        { artifactId: "t4-stray", s3Key: `${S1}/t4-stray` },
      ],
      ["SITE#s1", "TASK#t5", { taskId: "t5", status: "deleted" }],
      [
        "SITE#s1",
        "TASK#t5#UPDATE#2026-10-04T17:00:00.000Z#u1",
        { notes: ["Deleted note"], occurredAt: "2026-10-04T17:00:00.000Z" },
      ],
      // A duplicate sighting from another Check.
      [
        "SITE#s1",
        "TASK#t6",
        { taskId: "t6", checkId: "c2", sourceArtifactIds: ["art-9"] },
      ],
      ["SITE#s1", "DUP_LINK#t6", { taskId: "t6", originalTaskId: "t1" }],
      [
        "SITE#s1",
        "CHECK#c2#ART#art-9",
        {
          artifactId: "art-9",
          s3Key: "checks/s1/c2/art-9",
          capturedAt: "2026-10-06T17:00:00.000Z",
        },
      ],
      // A duplicate staff split back out.
      ["SITE#s1", "TASK#t7", { taskId: "t7", checkId: "c1" }],
      ["SITE#s1", "DUP_LINK#t7", { taskId: "t7", originalTaskId: "t1" }],
      ["SITE#s1", 'DUP_OVERRIDE#["c1","art-7","k7"]', { taskId: "t7" }],
      [
        "SITE#s1",
        "TASK#t7#UPDATE#2026-10-04T17:00:00.000Z#u1",
        { notes: ["Separated note"], occurredAt: "2026-10-04T17:00:00.000Z" },
      ],
      // Another Site's Check with the same ID.
      ["SITE#s2", "CHECK#c1", { checkId: "c1" }],
      [
        "SITE#s2",
        "CHECK#c1#ART#art-x",
        { artifactId: "art-x", s3Key: "checks/s2/c1/art-x" },
      ],
    ]).map(([pk, sk, row]) => [`${pk}|${sk}`, { pk, sk, ...row }]),
  );

/** @type {Map<string, Record<string, any>>} */
let rows;

beforeEach(() => {
  rows = table();
  send.mockReset();
  send.mockImplementation(async (/** @type {any} */ command) => {
    const input = command.input;
    if (input.Key) return { Item: rows.get(`${input.Key.pk}|${input.Key.sk}`) };
    const values = input.ExpressionAttributeValues;
    return {
      Items: [...rows.values()].filter(
        (r) => r.pk === values[":pk"] && r.sk.startsWith(values[":prefix"]),
      ),
    };
  });
});

/**
 * @param {string} key `pk|sk`
 * @param {Record<string, unknown>} fields
 */
const edit = (key, fields) => Object.assign(rows.get(key) ?? {}, fields);

/** @param {any[]} photos */
const ids = (photos) => photos.map((p) => [p.artifactId, p.source]);

describe("getRecordPhotos", () => {
  it("refuses compliance managers before reading, as the admin's photo route does", async () => {
    const res = await call(
      event({ checkId: "c1" }, { role: "compliance-manager" }),
    );
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
    // s2's Check c1 shares the ID, so this also shows only s1 is read.
    expect(body.photos).toEqual([
      expect.objectContaining({
        artifactId: "art-1",
        source: "check",
        url: `https://example.test/${S1}/art-1`,
        thumbnailUrl: `https://example.test/${S1}/art-1.thumb.webp`,
        urlSeconds: 300,
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

  it("answers 404 for a Check the Site doesn't have", async () => {
    expect((await call(event({ checkId: "nope" }))).status).toBe(404);
  });

  it("gives an Issue's sightings first, then photos and notes staff added on every task, oldest first", async () => {
    const { body } = await call(event({ issueId: "t1" }));
    expect(ids(body.photos)).toEqual([
      ["art-1", "check"],
      ["art-9", "check"],
      ["t4-u1-p1", "update"],
      ["t1-u2-p1", "update"],
    ]);
    expect(body.notes).toEqual([
      {
        source: "update",
        at: "2026-10-03T17:00:00.000Z",
        text: "Synthetic note",
      },
      {
        source: "update",
        at: "2026-10-04T17:00:00.000Z",
        text: "Synthetic action",
      },
    ]);
  });

  it("shows an iPhone update photo through its JPEG copy", async () => {
    const { body } = await call(event({ issueId: "t1" }));
    const heic = body.photos.find(
      (/** @type {any} */ p) => p.artifactId === "t1-u2-p1",
    );
    expect(heic.url).toBe(`https://example.test/${S1}/t1-u2-p1.display.jpg`);
    // No thumbnail yet, so the JPEG copy stands in.
    expect(heic.thumbnailUrl).toBe(heic.url);
  });

  it("ignores a JPEG copy stored under another name", async () => {
    edit("SITE#s1|TASK#t1#MEDIA#t1-u2-p1", { displayS3Key: `${S1}/other.jpg` });
    const { body } = await call(event({ issueId: "t1" }));
    expect(
      body.photos.find((/** @type {any} */ p) => p.artifactId === "t1-u2-p1")
        .url,
    ).toBe(`https://example.test/${S1}/t1-u2-p1`);
  });

  it("never signs a file outside the photo's own Site and Check", async () => {
    edit("SITE#s1|CHECK#c1#ART#art-1", { thumbS3Key: "checks/s2/c1/thumb" });
    edit("SITE#s1|TASK#t4#MEDIA#t4-u1-p1", { s3Key: "checks/s2/c1/t4-u1-p1" });
    const { body } = await call(event({ issueId: "t1" }));
    expect(ids(body.photos)).not.toContainEqual(["t4-u1-p1", "update"]);
    expect(body.photos[0].thumbnailUrl).toBe(
      `https://example.test/${S1}/art-1`,
    );
  });

  it("follows a duplicate linked through a replaced sighting, as the Issue list does", async () => {
    /** @param {string} sk @param {Record<string, unknown>} row */
    const put = (sk, row) =>
      rows.set(`SITE#s1|${sk}`, { pk: "SITE#s1", sk, ...row });
    put("TASK#t8", { taskId: "t8", checkId: "c2", status: "superseded" });
    put("DUP_LINK#t8", { taskId: "t8", originalTaskId: "t1" });
    put("TASK#t8#UPDATE#2026-10-07T17:00:00.000Z#u1", {
      notes: ["Replaced note"],
      occurredAt: "2026-10-07T17:00:00.000Z",
    });
    put("TASK#t9", {
      taskId: "t9",
      checkId: "c2",
      sourceArtifactIds: ["art-8"],
    });
    put("DUP_LINK#t9", { taskId: "t9", originalTaskId: "t8" });
    put("CHECK#c2#ART#art-8", {
      artifactId: "art-8",
      s3Key: "checks/s1/c2/art-8",
    });
    const { body } = await call(event({ issueId: "t1" }));
    expect(ids(body.photos)).toContainEqual(["art-8", "check"]);
    // The replaced sighting itself stays out.
    expect(body.notes.map((/** @type {any} */ n) => n.text)).not.toContain(
      "Replaced note",
    );
  });

  it("leaves out a duplicate of a replaced sighting that links nowhere, as the Issue list does", async () => {
    /** @param {string} sk @param {Record<string, unknown>} row */
    const put = (sk, row) =>
      rows.set(`SITE#s1|${sk}`, { pk: "SITE#s1", sk, ...row });
    // t1's condition still lists t8, which was replaced and kept no link of its own.
    put("ASSESSMENT#a1#COND#k1", { taskIds: ["t1", "t4", "t5", "t8"] });
    put("TASK#t8", { taskId: "t8", checkId: "c2", status: "superseded" });
    put("TASK#t9", {
      taskId: "t9",
      checkId: "c2",
      sourceArtifactIds: ["art-8"],
    });
    put("DUP_LINK#t9", { taskId: "t9", originalTaskId: "t8" });
    put("TASK#t9#UPDATE#2026-10-07T17:00:00.000Z#u1", {
      notes: ["Other Issue's note"],
      occurredAt: "2026-10-07T17:00:00.000Z",
    });
    put("CHECK#c2#ART#art-8", {
      artifactId: "art-8",
      s3Key: "checks/s1/c2/art-8",
    });
    const { body } = await call(event({ issueId: "t1" }));
    expect(ids(body.photos)).not.toContainEqual(["art-8", "check"]);
    expect(body.notes.map((/** @type {any} */ n) => n.text)).not.toContain(
      "Other Issue's note",
    );
  });

  it("keeps a duplicate of a replaced sighting the condition lists when that sighting links into the Issue", async () => {
    /** @param {string} sk @param {Record<string, unknown>} row */
    const put = (sk, row) =>
      rows.set(`SITE#s1|${sk}`, { pk: "SITE#s1", sk, ...row });
    put("ASSESSMENT#a1#COND#k1", { taskIds: ["t1", "t4", "t5", "t8"] });
    put("TASK#t8", { taskId: "t8", checkId: "c2", status: "superseded" });
    put("DUP_LINK#t8", { taskId: "t8", originalTaskId: "t4" });
    put("TASK#t9", {
      taskId: "t9",
      checkId: "c2",
      sourceArtifactIds: ["art-8"],
    });
    put("DUP_LINK#t9", { taskId: "t9", originalTaskId: "t8" });
    put("CHECK#c2#ART#art-8", {
      artifactId: "art-8",
      s3Key: "checks/s1/c2/art-8",
    });
    const { body } = await call(event({ issueId: "t1" }));
    expect(ids(body.photos)).toContainEqual(["art-8", "check"]);
  });

  it("keeps a replaced sighting's duplicate when the sighting's original joins in a later wave", async () => {
    /** @param {string} sk @param {Record<string, unknown>} row */
    const put = (sk, row) =>
      rows.set(`SITE#s1|${sk}`, { pk: "SITE#s1", sk, ...row });
    // Wave 1 reaches t8; its original t6 joins only in wave 2, as t4's duplicate.
    put("ASSESSMENT#a1#COND#k1", { taskIds: ["t1", "t4", "t5", "t8"] });
    put("TASK#t8", { taskId: "t8", checkId: "c2", status: "superseded" });
    put("DUP_LINK#t8", { taskId: "t8", originalTaskId: "t6" });
    put("TASK#t6", { taskId: "t6", checkId: "c2" });
    put("DUP_LINK#t6", { taskId: "t6", originalTaskId: "t4" });
    put("TASK#t9", {
      taskId: "t9",
      checkId: "c2",
      sourceArtifactIds: ["art-8"],
    });
    put("DUP_LINK#t9", { taskId: "t9", originalTaskId: "t8" });
    put("CHECK#c2#ART#art-8", {
      artifactId: "art-8",
      s3Key: "checks/s1/c2/art-8",
    });
    const { body } = await call(event({ issueId: "t1" }));
    expect(ids(body.photos)).toContainEqual(["art-8", "check"]);
  });

  it.each([
    ["t10", "t11"],
    ["t11", "t10"],
  ])(
    "keeps the duplicate at the end of two replaced sightings the condition lists as %s, %s",
    async (first, second) => {
      /** @param {string} sk @param {Record<string, unknown>} row */
      const put = (sk, row) =>
        rows.set(`SITE#s1|${sk}`, { pk: "SITE#s1", sk, ...row });
      put("ASSESSMENT#a1#COND#k1", {
        taskIds: ["t1", "t4", "t5", first, second],
      });
      put("TASK#t10", { taskId: "t10", checkId: "c2", status: "superseded" });
      put("DUP_LINK#t10", { taskId: "t10", originalTaskId: "t4" });
      put("TASK#t11", { taskId: "t11", checkId: "c2", status: "deleted" });
      put("DUP_LINK#t11", { taskId: "t11", originalTaskId: "t10" });
      put("TASK#t12", {
        taskId: "t12",
        checkId: "c2",
        sourceArtifactIds: ["art-8"],
      });
      put("DUP_LINK#t12", { taskId: "t12", originalTaskId: "t11" });
      put("CHECK#c2#ART#art-8", {
        artifactId: "art-8",
        s3Key: "checks/s1/c2/art-8",
      });
      const { body } = await call(event({ issueId: "t1" }));
      expect(ids(body.photos)).toContainEqual(["art-8", "check"]);
    },
  );

  it("finds a sighting's photo saved under the older key with a place segment", async () => {
    rows.delete("SITE#s1|CHECK#c2#ART#art-9");
    rows.set("SITE#s1|CHECK#c2#ART#place-1#art-9", {
      pk: "SITE#s1",
      sk: "CHECK#c2#ART#place-1#art-9",
      artifactId: "art-9",
      s3Key: "checks/s1/c2/art-9",
    });
    const { body } = await call(event({ issueId: "t1" }));
    expect(ids(body.photos)).toContainEqual(["art-9", "check"]);
  });

  it("shows only a replaced task's own notes, since no Issue counts it", async () => {
    const { body } = await call(event({ issueId: "t5" }));
    expect(body.notes.map((/** @type {any} */ n) => n.text)).toEqual([
      "Deleted note",
    ]);
  });

  it("answers 404 for an Issue the Site doesn't have", async () => {
    expect((await call(event({ issueId: "nope" }))).status).toBe(404);
    expect(
      (await call(event({ issueId: "t1" }, { siteId: "s2" }))).status,
    ).toBe(404);
  });

  it("matches the admin E2E fake's replies", async () => {
    /** @param {unknown} v @returns {unknown} */
    const shape = (v) =>
      Array.isArray(v)
        ? [shape(v[0])]
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, x]) => [k, shape(x)]),
            )
          : typeof v;
    const params = (/** @type {Record<string, string>} */ q) =>
      new URLSearchParams(q);
    /** @type {Record<string, string>[]} */
    const found = [{ checkId: "c1" }, { issueId: "t1" }];
    for (const query of found) {
      const real = await call(event(query));
      const fake = recordPhotosReply("s1", params(query));
      expect(shape(fake.json)).toEqual(shape(real.body));
      expect(fake.status ?? 200).toBe(real.status);
    }
    /** @type {Record<string, string>[]} */
    const refused = [{}, { checkId: "nope" }, { issueId: "nope" }];
    for (const query of refused) {
      const real = await call(event(query));
      expect(recordPhotosReply("s1", params(query))).toEqual({
        status: real.status,
        json: real.body,
      });
    }
  });
});
