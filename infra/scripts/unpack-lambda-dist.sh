#!/usr/bin/env bash
# npm code built this archive, so plan-dev.yml lets only regular files under
# backend/dist reach the checkout that terraform and jq then run from.
# Usage: unpack-lambda-dist.sh <archive> <checkout root>
set -euo pipefail

archive="$1"
root="$2"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT

tar -xzf "$archive" -C "$staging"

bad="$(find "$staging" -mindepth 1 \( ! -type f ! -type d \) -print -quit)"
if [ -n "$bad" ]; then
  echo "Lambda bundle archive holds a link or special file: ${bad#"$staging"/}" >&2
  exit 1
fi
outside="$(find "$staging" -mindepth 1 ! -path "$staging/backend" \
  ! -path "$staging/backend/dist" ! -path "$staging/backend/dist/*" -print -quit)"
if [ -n "$outside" ]; then
  echo "Lambda bundle archive holds a path outside backend/dist: ${outside#"$staging"/}" >&2
  exit 1
fi
if [ ! -d "$staging/backend/dist" ]; then
  echo "Lambda bundle archive has no backend/dist" >&2
  exit 1
fi
if [ -e "$root/backend/dist" ] || [ -L "$root/backend/dist" ]; then
  echo "backend/dist already exists in the checkout" >&2
  exit 1
fi

mkdir -p "$root/backend"
cp -pR "$staging/backend/dist" "$root/backend/dist"
