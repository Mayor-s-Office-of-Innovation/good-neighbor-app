# One line per changed resource for plan-dev.yml's public summary: the action, the
# address and, for an update or replace, the names of changed top-level attributes.
# Values never appear, because a plan holds Lambda environments and secrets.
def unknown($u): [$u | .. | select(. == true)] | length > 0;
def changed:
  (.before // {}) as $b | (.after // {}) as $a | (.after_unknown // {}) as $u
  | [(($b | keys) + ($a | keys) + ($u | keys) | unique)[] | select($b[.] != $a[.] or unknown($u[.]))];

[.resource_changes[]? | select(.change.actions != ["no-op"])]
| sort_by(.address)[]
| "\(.change.actions | join("+"))\t\(.address)" + (
    if (.change.before | type) == "object" and (.change.after | type) == "object" then
      "\t\(.change | changed | join(","))"
      + (if (.change.replace_paths // []) | length > 0
         then "\treplaced for: \(.change.replace_paths | map(.[0] | tostring) | unique | join(","))"
         else "" end)
    else "" end
  )
