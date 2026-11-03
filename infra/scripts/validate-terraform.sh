#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

# A checkout can keep CI's Terraform version here when the system version
# differs. Git GUI clients may not inherit a terminal's PATH overrides.
required_version=$(sed -nE 's/^[[:space:]]*required_version[[:space:]]*=[[:space:]]*"=[[:space:]]*([0-9]+\.[0-9]+\.[0-9]+)".*$/\1/p' infra/bootstrap/prod-state/main.tf)
if [[ -z "$required_version" ]]; then
  echo "Cannot determine the exact Terraform version required by infra/bootstrap/prod-state/main.tf." >&2
  exit 1
fi

terraform_bin=
for candidate in "$PWD/.terraform/bin/terraform" terraform; do
  if version=$("$candidate" version 2>/dev/null | sed -n '1s/^Terraform v//p') && [[ "$version" == "$required_version" ]]; then
    terraform_bin=$candidate
    break
  fi
done
if [[ -z "$terraform_bin" ]]; then
  echo "Terraform $required_version is required. Install it on PATH or at .terraform/bin/terraform in this checkout." >&2
  exit 1
fi

# The app is a child module: its aws.us_east_1 provider is supplied by
# these roots. Validating the module alone incorrectly reports it missing.
# Include bootstrap as well so every deployable root remains checked.
for root in infra/environments/dev infra/environments/prod infra/bootstrap/prod-state; do
  "$terraform_bin" -chdir="$root" init -backend=false -input=false -lockfile=readonly -no-color
  "$terraform_bin" -chdir="$root" validate -no-color
done
