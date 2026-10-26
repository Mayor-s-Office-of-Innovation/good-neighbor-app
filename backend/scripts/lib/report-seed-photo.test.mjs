import { test } from "vitest";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { putSeedPhoto } from "./report-seed-photo.mjs";
const Body = Buffer.from("fixture");
const input = {
  Bucket: "gnp-local-uploads",
  Key: "fixture.jpg",
  Body,
  seedId: "seed",
};
const metadata = {
  ContentType: "image/jpeg",
  ContentLength: Body.length,
  Metadata: { seed: "seed" },
};
function occupied(head, bytes = Body) {
  const commands = [];
  return {
    commands,
    async send(command) {
      commands.push(command);
      if (commands.length === 1) throw { $metadata: { httpStatusCode: 412 } };
      if (commands.length === 2) return head;
      return { Body: { transformToByteArray: async () => bytes } };
    },
  };
}
test("publishes fixture identity alongside an overwrite-protected upload", async () => {
  let saved;
  await putSeedPhoto(
    {
      send: async (command) => {
        saved = command.input;
      },
    },
    input,
  );
  assert.equal(saved.IfNoneMatch, "*");
  assert.equal(
    saved.Metadata.sha256,
    createHash("sha256").update(Body).digest("hex"),
  );
});
test("accepts a verified rerun and verifies bytes of older seeds", async () => {
  const old = occupied(metadata);
  await putSeedPhoto(old, input);
  assert.equal(old.commands.length, 3);
  const current = occupied({
    ...metadata,
    Metadata: {
      ...metadata.Metadata,
      sha256: createHash("sha256").update(Body).digest("hex"),
    },
  });
  await putSeedPhoto(current, input);
  assert.equal(current.commands.length, 2);
});
test("rejects foreign or different fixture content without overwriting it", async () => {
  for (const s3 of [
    occupied({ ...metadata, Metadata: { seed: "foreign" } }),
    occupied(metadata, Buffer.from("changed")),
    occupied({
      ...metadata,
      Metadata: { ...metadata.Metadata, sha256: "different" },
    }),
  ]) {
    await assert.rejects(putSeedPhoto(s3, input), /collision|mismatch/);
    assert.equal(
      s3.commands.filter((c) => c.constructor.name === "PutObjectCommand")
        .length,
      1,
    );
  }
});
