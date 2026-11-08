#!/usr/bin/env bash
# Usage: tf-init-retry.sh <init args...>  Registry discovery can fail with a transient
# connection reset, so CI's inits retry here, in one place, instead of in a loop pasted into each step.
# It always adds -backend=false and refuses any backend flag, so its callers never need credentials.
set -uo pipefail

for arg in "$@"; do
  case "$arg" in
    -backend | -backend=* | --backend | --backend=*)
      echo "tf-init-retry.sh: $arg isn't allowed; this script never inits a backend." >&2
      exit 2
      ;;
  esac
done

delay="${TF_INIT_RETRY_DELAY:-10}"
for attempt in 1 2 3; do
  if terraform init -backend=false "$@"; then
    exit 0
  else
    status=$?
  fi
  if [ "$attempt" -eq 3 ]; then
    exit "$status"
  fi
  echo "Terraform initialization failed; retrying in ${delay} seconds (attempt $attempt/3)."
  sleep "$delay"
done
