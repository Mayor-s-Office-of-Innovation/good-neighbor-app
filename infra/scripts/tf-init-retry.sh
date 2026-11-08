#!/usr/bin/env bash
# Registry discovery can fail with a transient connection reset, so CI's inits
# retry here, in one place, instead of in a loop pasted into each step.
set -uo pipefail

delay="${TF_INIT_RETRY_DELAY:-10}"
for attempt in 1 2 3; do
  if terraform init "$@"; then
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
