#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

# The app is a child module: its aws.us_east_1 provider is supplied by
# these roots. Validating the module alone incorrectly reports it missing.
# Include bootstrap as well so every deployable root remains checked.
for root in infra/environments/dev infra/environments/prod infra/bootstrap/prod-state; do
  terraform -chdir="$root" init -backend=false -input=false -lockfile=readonly -no-color
  terraform -chdir="$root" validate -no-color
done
