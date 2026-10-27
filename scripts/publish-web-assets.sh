#!/usr/bin/env bash
set -euo pipefail

# Keep hashed assets for already-open clients. Do not use --delete here:
# a newer index does not change the module URLs held by those browsers.
# Source maps stay private in PostHog. Publish entry HTML only after every
# resource it references has finished uploading.
source_dir="${1:?Build directory required}"
destination="${2:?S3 destination required}"
aws s3 sync "$source_dir/assets" "$destination/assets" \
  --exclude '*.map' --cache-control 'public,max-age=31536000,immutable'
aws s3 sync "$source_dir" "$destination" \
  --exclude 'assets/*' --exclude '*.html' --exclude '*.map' --cache-control 'no-cache'
aws s3 sync "$source_dir" "$destination" \
  --exclude '*' --include '*.html' --cache-control 'no-cache'
