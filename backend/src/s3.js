import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Single shared S3 client, mirroring db.js. Region/credentials/endpoint come
// from the environment (AWS_ENDPOINT_URL_S3 redirects at MinIO in the Step D
// harness). MinIO on localhost only speaks path-style addressing (virtual-host
// `bucket.localhost` won't resolve), and the SDK has no env var for that — so
// flip forcePathStyle on only when an S3 endpoint override is present. Real AWS
// (no override) is untouched. Handlers and the analyze worker go through the
// wrappers below so tests can vi.mock this one module.
const client = new S3Client(
  process.env.AWS_ENDPOINT_URL_S3 ? { forcePathStyle: true } : {},
);

// Fail loud on a credential mismatch against the local MinIO. A stale MinIO
// from an earlier stack (different .env.local creds) can still answer health
// checks — so the reuse lane parks on it and every app S3 operation then fails
// signature validation. That surfaces here, buried in SDK noise mid-upload;
// this middleware translates it into one actionable warning. Real AWS shares
// these error codes, but the remediation hint is scoped to the local endpoint.
client.middlewareStack.use({
  applyToStack: (/** @type {any} */ stack) => {
    stack.add((/** @type {any} */ next) => async (/** @type {any} */ args) => {
      try {
        return await next(args);
      } catch (/** @type {any} */ err) {
        const code = err?.name ?? err?.Code;
        if (
          (code === "SignatureDoesNotMatch" || code === "InvalidAccessKeyId") &&
          process.env.AWS_ENDPOINT_URL_S3?.includes("127.0.0.1")
        ) {
          console.error(
            "[s3] " +
              code +
              " against local MinIO — the running MinIO was likely started with DIFFERENT credentials than this stack's .env.local. Kill it (lsof -ti :9000 | xargs kill) and restart the dev stack.",
          );
        }
        throw err;
      }
    });
  },
});

/**
 * Presign a PUT so the device can upload media straight to S3. The content-type
 * and key are pinned into the signature — the client must send exactly this
 * content-type to that key. S3 can't enforce a max object size on a presigned
 * PUT, so the analyze worker enforces size (and content sniffing) when it reads
 * the object back.
 * @param {object} params
 * @param {string} params.bucket
 * @param {string} params.key
 * @param {string} params.contentType
 * @param {number} [params.expiresIn] seconds (default 300)
 * @returns {Promise<string>}
 */
export function presignPut({ bucket, key, contentType, expiresIn = 300 }) {
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(client, command, { expiresIn });
}

/**
 * Presign a short-lived GET so an admin can review stored media.
 * @param {object} params
 * @param {string} params.bucket
 * @param {string} params.key
 * @param {number} [params.expiresIn] seconds (default 300)
 * @returns {Promise<string>}
 */
export function presignGet({ bucket, key, expiresIn = 300 }) {
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  return getSignedUrl(client, command, { expiresIn });
}

/**
 * Read an object's bytes. Used by the analyze worker to fetch uploaded media
 * before downscaling + base64-encoding it for the analyzer.
 * @param {object} params
 * @param {string} params.bucket
 * @param {string} params.key
 * @returns {Promise<{ bytes: Buffer, contentType?: string, contentLength?: number }>}
 */
export async function getObjectBytes({ bucket, key }) {
  const out = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  if (!out.Body) {
    throw new Error(`S3 object has no body: ${key}`);
  }
  const bytes = Buffer.from(await out.Body.transformToByteArray());
  return {
    bytes,
    contentType: out.ContentType,
    contentLength: out.ContentLength,
  };
}
