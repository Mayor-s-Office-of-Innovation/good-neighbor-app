// Each requester has their own prefix; files leave only through a link that expires in minutes.

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { setImmediate } from "node:timers";

/** @typedef {{ send: (cmd: any) => Promise<any> }} Sender */

/**
 * @param {{ s3: Sender, presignClient?: any, bucket: string, prefix?: string }} opts
 * @returns {import("./jobs.js").JobStore}
 */
export function s3JobStore({
  s3,
  presignClient = s3,
  bucket,
  prefix = "insights-jobs",
}) {
  /**
   * @param {string} owner
   * @param {string} jobId
   */
  const recordKey = (owner, jobId) => `${prefix}/${owner}/${jobId}.json`;
  /**
   * @param {string} owner
   * @param {string} jobId
   */
  const resultKey = (owner, jobId) => `${prefix}/${owner}/${jobId}.out`;
  /**
   * @param {string} key
   * @param {Record<string, any>} record
   * @param {Record<string, any>} [extra]
   */
  const write = (key, record, extra = {}) =>
    s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: JSON.stringify(record),
        ContentType: "application/json",
        ...extra,
      }),
    );
  return {
    async create(owner, jobId, record) {
      try {
        // A double click sends two creates; only the first may win.
        await write(recordKey(owner, jobId), record, { IfNoneMatch: "*" });
        return true;
      } catch (err) {
        const status = /** @type {any} */ (err)?.$metadata?.httpStatusCode;
        if (status === 412 || status === 409) return false;
        throw err;
      }
    },
    async get(owner, jobId) {
      try {
        const res = await s3.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: recordKey(owner, jobId),
          }),
        );
        return JSON.parse(await res.Body.transformToString());
      } catch (err) {
        // Needs s3:ListBucket, or S3 answers a missing key with 403 and every new job fails.
        if (/** @type {any} */ (err)?.name === "NoSuchKey") return null;
        throw err;
      }
    },
    async put(owner, jobId, record) {
      await write(recordKey(owner, jobId), record);
    },
    async putResult(owner, jobId, body, contentType) {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: resultKey(owner, jobId),
          Body: body,
          ContentType: contentType,
        }),
      );
    },
    async deleteResult(owner, jobId) {
      await s3.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: resultKey(owner, jobId),
        }),
      );
    },
    resultUrl(owner, jobId, filename, seconds) {
      const safe = filename.replace(/[^A-Za-z0-9._-]/g, "_");
      return getSignedUrl(
        presignClient,
        new GetObjectCommand({
          Bucket: bucket,
          Key: resultKey(owner, jobId),
          ResponseContentDisposition: `attachment; filename="${safe}"`,
        }),
        { expiresIn: seconds },
      );
    },
  };
}

// Queued, so it runs in its own invocation with its own time limit.
/**
 * @param {{ sqs: Sender, queueUrl: string }} opts
 * @returns {(ref: { ownerKey: string, jobId: string }) => Promise<void>}
 */
export function sqsStarter({ sqs, queueUrl }) {
  return async (ref) => {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({ insightsJob: ref }),
      }),
    );
  };
}

// For the local API, which runs the job in-process after replying.
/**
 * @param {() => (ref: { ownerKey: string, jobId: string }) => Promise<void>} runner
 * @returns {(ref: { ownerKey: string, jobId: string }) => Promise<void>}
 */
export function inProcessStarter(runner) {
  return async (ref) => {
    setImmediate(() => {
      runner()(ref).catch((err) =>
        console.error("[insights] local job failed", err),
      );
    });
  };
}
