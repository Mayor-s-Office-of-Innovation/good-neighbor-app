import { createHash } from "node:crypto";
import {
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";

/** Publish only this fixture's bytes, preserving existing objects on reruns.
 * Older seeds have no checksum metadata, so verify their bytes before reuse.
 * @param {import("@aws-sdk/client-s3").S3Client} s3
 * @param {{Bucket: string, Key: string, Body: Buffer, seedId: string}} input
 */
export async function putSeedPhoto(s3, { Bucket, Key, Body, seedId }) {
  const digest = createHash("sha256").update(Body).digest("hex");
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket,
        Key,
        Body,
        ContentType: "image/jpeg",
        IfNoneMatch: "*",
        Metadata: { seed: seedId, sha256: digest },
      }),
    );
  } catch (error) {
    if (error?.$metadata?.httpStatusCode !== 412) throw error;
    const existing = await s3.send(new HeadObjectCommand({ Bucket, Key }));
    if (
      existing.Metadata?.seed !== seedId ||
      existing.ContentLength !== Body.length ||
      existing.ContentType !== "image/jpeg"
    )
      throw new Error(`Seed photo collision: ${Key}`);
    let existingDigest = existing.Metadata?.sha256;
    if (!existingDigest) {
      const object = await s3.send(new GetObjectCommand({ Bucket, Key }));
      if (!object.Body) throw new Error(`Missing seed photo body: ${Key}`);
      existingDigest = createHash("sha256")
        .update(await object.Body.transformToByteArray())
        .digest("hex");
    }
    if (existingDigest !== digest)
      throw new Error(`Seed photo content mismatch: ${Key}`);
  }
}
