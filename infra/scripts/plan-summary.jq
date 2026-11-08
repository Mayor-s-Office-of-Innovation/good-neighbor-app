# One line per changed resource for plan-dev.yml's public summary: the action, the
# address and, for an update or replace, the names of changed top-level attributes.
# Values never appear, because a plan holds Lambda environments and secrets.
include "public-address" {search: "./"};

def unknown($u): [$u | .. | select(. == true)] | length > 0;
def changed:
  (.before // {}) as $b | (.after // {}) as $a | (.after_unknown // {}) as $u
  | [(($b | keys) + ($a | keys) + ($u | keys) | unique)[] | select($b[.] != $a[.] or unknown($u[.]))];

# Sorting on the cut address hides which for_each key changed what.
[.resource_changes[]? | select(.change.actions != ["no-op"])
 | (.address | public_address) as $addr
 | {addr: $addr,
    line: ("\(.change.actions | join("+"))\t\($addr)" + (
      if (.change.before | type) == "object" and (.change.after | type) == "object" then
        "\t\(.change | changed | join(","))"
        + (if (.change.replace_paths // []) | length > 0
           then "\treplaced for: \(.change.replace_paths | map(.[0] | tostring) | unique | join(","))"
           else "" end)
      else "" end))}]
| group_by([.addr, .line])[]
| .[0].line + (if length > 1 then "\t×\(length)" else "" end)
