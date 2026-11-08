#!/usr/bin/env bash
# Usage: tf-init-retry.sh [--backend] <init args...>  Registry discovery can fail with a transient
# connection reset, so CI's inits retry here, in one place, instead of in a loop pasted into each step.
# Inits skip the backend unless the first argument is --backend, so CI's credential-free calls stay safe.
set -uo pipefail

delay="${TF_INIT_RETRY_DELAY:-10}"
backend=false
if [ "${1:-}" = "--backend" ]; then
  backend=true
  shift
else
  set -- -backend=false "$@"
fi
for arg in "$@"; do
  if [ "$arg" = "--backend" ]; then
    echo "tf-init-retry.sh: --backend must be the first argument." >&2
    exit 2
  fi
done

# A backend init can fail on bad credentials or config, which no retry fixes, so it retries
# only these network and throttling errors. grep stays quiet, since the log can quote state.
transient() {
  grep -q -E \
    -e 'connection reset' \
    -e 'i/o timeout' \
    -e 'TLS handshake timeout' \
    -e 'context deadline exceeded' \
    -e '(registry\.terraform\.io|releases\.hashicorp\.com).*EOF' \
    -e '(registry\.terraform\.io|releases\.hashicorp\.com).*[^0-9.](5[0-9]{2}|429) [A-Z]' \
    -e '(^|[^A-Za-z])(Throttling|ThrottlingException|RequestLimitExceeded)([^A-Za-z]|$)' \
    "$1" > /dev/null 2>&1
}

if [ "$backend" = true ]; then
  log="$(mktemp)"
  trap 'rm -f "$log"' EXIT
fi
for attempt in 1 2 3; do
  if [ "$backend" = true ]; then
    terraform init "$@" 2>&1 | tee "$log"
    status="${PIPESTATUS[0]}"
  elif terraform init "$@"; then
    status=0
  else
    status=$?
  fi
  if [ "$status" -eq 0 ]; then
    exit 0
  fi
  if [ "$attempt" -eq 3 ] || { [ "$backend" = true ] && ! transient "$log"; }; then
    exit "$status"
  fi
  echo "Terraform initialization failed; retrying in ${delay} seconds (attempt $attempt/3)."
  sleep "$delay"
done
