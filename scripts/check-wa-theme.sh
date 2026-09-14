#!/usr/bin/env bash
# Drift guard for the vendored Web Awesome theme (frontend/src/styles/wa-awesome.css).
#
# The fork exists for exactly three documented transformations of upstream
# dist/styles/themes/awesome.css (see the file header):
#   1. the https://fonts.bunny.net font @import is stripped (CDN-free requirement)
#   2. the two sibling @imports are rewritten to package paths
#   3. the font tokens (--wa-font-family-body/longform) point at our system stack
#      instead of Quicksand / Crimson Pro
#
# This script normalizes those known transformations out of both files and diffs.
# ANY other difference fails — i.e. bumping @awesome.me/webawesome without
# re-vendoring the theme breaks this check. Re-vendor, re-derive the delta, and
# update the KNOWN list below if the intentional transformations change.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDORED="$ROOT/frontend/src/styles/wa-awesome.css"
UPSTREAM="$ROOT/node_modules/@awesome.me/webawesome/dist/styles/themes/awesome.css"

if [ ! -f "$UPSTREAM" ]; then
  echo "check-wa-theme: upstream theme not found — is @awesome.me/webawesome installed?" >&2
  exit 1
fi

version="$(node -p "require('$ROOT/node_modules/@awesome.me/webawesome/package.json').version")"
vendored_version="$(sed -n 's/.*webawesome@\([0-9.]*\).*/\1/p' "$VENDORED" | head -1)"
if [ -n "$vendored_version" ] && [ "$vendored_version" != "$version" ]; then
  echo "check-wa-theme: VERSION DRIFT — vendored theme is from @$vendored_version but node_modules has @$version." >&2
  echo "  Re-vendor: copy the upstream file, re-strip the font @import, rewrite the" >&2
  echo "  two @import paths, and re-apply the font-token swap (see the fork header)." >&2
  exit 1
fi

normalize() {
  # Drop: the vendored header comment block (everything before the last `*/`),
  # comment tails (anything from `/*` onward on a line), blank lines, the
  # bunny.net font import, and any @import line.
  # This removes transformations 1 and 2 wholesale; transformation 3 is covered
  # by the font-family filter below (it only ever touches --wa-font-family-*).
  # The VENDORED header lives INSIDE the leading comment block of the vendored
  # file, so stripping to the last `*/` before the first `{` handles both files'
  # headers. Simplest robust rule: drop everything up to the first `@layer`.
  sed -E '0,/@layer wa-theme/s//KEEP@layer wa-theme/' \
    | sed -n '/KEEP@layer wa-theme/,$p' \
    | sed -E 's#/\*.*##' \
    | grep -vE "bunny\.net|@import|^\s*\*|^\s*$" \
    | grep -v -- "--wa-font-family-"
}

if diff <(normalize < "$UPSTREAM") <(normalize < "$VENDORED") > /tmp/wa-theme-drift.diff; then
  echo "check-wa-theme: OK (vendored theme matches upstream @$version within the known delta)"
else
  echo "check-wa-theme: UNEXPECTED DRIFT between vendored wa-awesome.css and upstream @$version" >&2
  echo "(known transformations — font @import strip, @import rewrites, font tokens — are normalized out; anything below is real)" >&2
  cat /tmp/wa-theme-drift.diff >&2
  exit 1
fi