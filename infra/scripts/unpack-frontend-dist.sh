#!/usr/bin/env bash
# build-frontend built this archive (and may have run @posthog/cli), so
# deploy.yml lets only regular files under frontend/dist reach the
# AWS-credentialed checkout before S3 publication.
# Usage: unpack-frontend-dist.sh <archive> <checkout root>
set -euo pipefail

archive="$1"
root="$2"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT

tar -xzf "$archive" -C "$staging"

bad="$(find "$staging" -mindepth 1 \( ! -type f ! -type d \) -print -quit)"
if [ -n "$bad" ]; then
  echo "Frontend bundle archive holds a link or special file: ${bad#"$staging"/}" >&2
  exit 1
fi
outside="$(find "$staging" -mindepth 1 ! -path "$staging/frontend" \
  ! -path "$staging/frontend/dist" ! -path "$staging/frontend/dist/*" -print -quit)"
if [ -n "$outside" ]; then
  echo "Frontend bundle archive holds a path outside frontend/dist: ${outside#"$staging"/}" >&2
  exit 1
fi
if [ ! -d "$staging/frontend/dist" ]; then
  echo "Frontend bundle archive has no frontend/dist" >&2
  exit 1
fi
if [ -e "$root/frontend/dist" ] || [ -L "$root/frontend/dist" ]; then
  echo "frontend/dist already exists in the checkout" >&2
  exit 1
fi

mkdir -p "$root/frontend"
cp -pR "$staging/frontend/dist" "$root/frontend/dist"
