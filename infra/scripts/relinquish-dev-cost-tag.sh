#!/usr/bin/env bash
# CI-only state migration. Never call the Cost Explorer activation API.
set -euo pipefail

if [ "${DEPLOY_ENVIRONMENT:-}" != "dev" ] && [ "${DEPLOY_ENVIRONMENT:-}" != "prod" ]; then
  echo "Cost-tag state migration is allowed only for DEV or PROD." >&2
  exit 1
fi

address='module.app.aws_ce_cost_allocation_tag.application'
entries="$(terraform state list)"
if grep -Fxq "$address" <<< "$entries" || grep -Fxq "$address[0]" <<< "$entries"; then
  # Removing the resource address covers both legacy and indexed instances.
  # The backend lock and versioned S3 state preserve the normal recovery path.
  terraform state rm -lock-timeout=5m "$address"
else
  echo "No cost-tag activation entry remains; no state change needed."
fi
