# Photo thumbnails

The analysis worker creates a display-only JPEG (400px maximum long edge,
quality 75, EXIF-oriented, no upscaling or retained metadata) in the private
uploads bucket at `<original-key>/thumbnails/v1.jpg`. The original and the
1568px analyzer derivative retain their existing roles. The analyzer derivative
is still transient; the thumbnail is persisted.

After the thumbnail upload succeeds, the artifact's `thumbnail` field records
`s3Key`, `width`, `height`, and `contentType`. A conditional update avoids
recreating a deleted artifact or attaching a preview to a replaced source.
Repeated processing skips an artifact whose current thumbnail is recorded.

`GET /v1/checks/{checkId}/artifacts/{artifactId}/media?variant=thumbnail`
returns a signed thumbnail URL, falling back to the original for legacy or
failed thumbnail generation. Omit `variant` for the original. Both requests
use the existing site-scoped artifact lookup. Analysis cards use the thumbnail
variant; URLs are cached separately by variant. Local capture cards use a small
canvas-generated preview while the original remains available for upload.

Thumbnail failures are logged and do not fail condition analysis. Use the
backfill below to retry without invoking the analyzer. No cloud resources are
created separately; the worker gains PutObject only for thumbnail paths.

## Retention and deletion

Thumbnails use the same bucket, encryption, and lifecycle rules as originals.
Currently deleting an artifact deletes its database record, not its S3 original;
the thumbnail follows that behavior and can no longer be signed through the API.
There is no current-version image expiration rule. A future physical purge must
remove both the original and its `/thumbnails/` objects, including versions.

## Backfill or retry

Run with credentials/configuration for the intended environment. The script
requires `DYNAMO_TABLE`, `S3_UPLOAD_BUCKET`, and the usual AWS region/credentials.
For local emulators also load their endpoint configuration. It makes no AI calls.

From the repository root, preview a bounded batch for one site:

```sh
node --env-file=.env.local backend/scripts/backfill-thumbnails.mjs --site SITE_ID --limit 100
```

After reviewing the environment and candidates, add `--apply` to write:

```sh
node --env-file=.env.local backend/scripts/backfill-thumbnails.mjs --site SITE_ID --limit 100 --apply
```

For deployed environments, use the appropriate environment configuration rather
than `.env.local`. The operator needs DynamoDB Query/GetItem/UpdateItem and S3
GetObject/PutObject, plus the uploads KMS key permissions. Start with a small
batch. Successful artifacts are skipped on subsequent runs; failures are logged
and produce a nonzero exit status. The limit caps candidates per invocation;
queries may read more records while finding candidates.

Deploy backend/IAM before or alongside the frontend. No backfill is required for
compatibility; legacy cards remain usable through original-image fallback.
