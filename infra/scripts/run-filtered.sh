#!/usr/bin/env bash
# Usage: run-filtered.sh <raw log> <command...>  For plan-dev.yml's public log: Terraform's
# text can quote state, so it stays in the raw log and only plan-diagnostics.jq's lines print.
set -uo pipefail

log="$1"
shift
status=0
"$@" > "$log" 2>&1 || status=$?
# jq's own errors can quote the input, so they're dropped for a fixed line.
if ! jq -n -R -r --arg status "$status" -f "$(dirname "$0")/plan-diagnostics.jq" "$log" 2> /dev/null; then
  echo "Could not filter Terraform's output, so none of it is shown."
  [ "$status" -ne 0 ] || status=1
fi
exit "$status"
