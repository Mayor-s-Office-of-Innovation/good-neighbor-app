import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Single shared S3 client, mirroring db.js. Region/credentials come from the
// environment (and AWS_ENDPOINT_URL_S3 locally), so pointing at MinIO in the
// Step D harness needs no code change. Handlers and the analyze worker go
// through the wrappers below so tests can vi.mock this one module.
const client = new S3Client({});

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
