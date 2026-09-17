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

normalize_imports() {
  # Imports live BEFORE the @layer cut, so they must be normalized and compared
  # separately. Rewrite each known import to a canonical token:
  #   upstream:   @import url('../layers.css'); etc.
  #   vendored:   @import '@awesome.me/webawesome/dist/styles/...';
  # and strip the bunny.net font import (transformation 1). An ADDED, REMOVED,
  # or re-pointed import then shows as a diff line instead of vanishing.
  perl -0777 -pe 's#/\*.*?\*/##gs' \
    | grep -v "fonts\.bunny\.net" \
    | sed -E "s#@import url\('../layers\.css'\);#@IMPORT-X-LAYERS#; s#@import url\('../color/palettes/bright\.css'\);.*#@IMPORT-X-PALETTE#" \
    | sed -E "s#@import '@awesome\.me/webawesome/dist/styles/layers\.css';#@IMPORT-X-LAYERS#; s#@import '@awesome\.me/webawesome/dist/styles/color/palettes/bright\.css';#@IMPORT-X-PALETTE#" \
    | grep -E '^@IMPORT|^@import'
}

normalize_body() {
  # The theme body: everything from the first `@layer` onward, with /* */
  # comments (multi-line aware) removed and ONLY the two swapped font tokens
  # neutralized (transformation 3 — body/longform). Heading/code font tokens
  # stay guarded: an upstream change to them shows as drift.
  # (awk's found-flag is the portable "from first match to EOF" — BSD sed has
  # no GNU `0,/pat/` address form.)
  awk '/@layer wa-theme/{found=1} found' \
    | perl -0777 -pe 's#/\*.*?\*/##gs' \
    | sed -E 's#--wa-font-family-body: [^;]+;#--wa-font-family-body: NORMALIZED;#; s#--wa-font-family-longform: [^;]+;#--wa-font-family-longform: NORMALIZED;#' \
    | grep -vE "^\s*$"
}

if diff <(normalize_imports < "$UPSTREAM") <(normalize_imports < "$VENDORED") > /tmp/wa-theme-drift.diff &&
   diff <(normalize_body < "$UPSTREAM") <(normalize_body < "$VENDORED") >> /tmp/wa-theme-drift.diff; then
  echo "check-wa-theme: OK (vendored theme matches upstream @$version within the known delta)"
else
  echo "check-wa-theme: UNEXPECTED DRIFT between vendored wa-awesome.css and upstream @$version" >&2
  echo "(imports are compared after canonical path rewrite; body normalizes ONLY the body/longform font tokens; anything below is real)" >&2
  cat /tmp/wa-theme-drift.diff >&2
  exit 1
fi