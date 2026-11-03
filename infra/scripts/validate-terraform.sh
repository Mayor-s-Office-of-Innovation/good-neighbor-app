#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

# A checkout can keep CI's Terraform version here when the system version
# differs. Git GUI clients may not inherit a terminal's PATH overrides.
terraform_bin=terraform
if [[ -x .terraform/bin/terraform ]]; then
  terraform_bin="$PWD/.terraform/bin/terraform"
fi

# The app is a child module: its aws.us_east_1 provider is supplied by
# these roots. Validating the module alone incorrectly reports it missing.
# Include bootstrap as well so every deployable root remains checked.
for root in infra/environments/dev infra/environments/prod infra/bootstrap/prod-state; do
  "$terraform_bin" -chdir="$root" init -backend=false -input=false -lockfile=readonly -no-color
  "$terraform_bin" -chdir="$root" validate -no-color
done
