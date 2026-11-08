# One line per changed resource for plan-dev.yml's public summary: the action, the
# address and, for an update or replace, the names of changed top-level attributes.
# Values never appear, because a plan holds Lambda environments and secrets.
include "public-address" {search: "./"};

def unknown($u): [$u | .. | select(. == true)] | length > 0;
def changed:
  (.before // {}) as $b | (.after // {}) as $a | (.after_unknown // {}) as $u
  | [(($b | keys) + ($a | keys) + ($u | keys) | unique)[] | select($b[.] != $a[.] or unknown($u[.]))];

# An import or a move with no attribute change is still a no-op, so name it; the
# import ID is a value and never prints.
def action:
  [(if .change.importing then "import" else empty end),
   (if .previous_address then "move" else empty end),
   (.change.actions[] | select(. != "no-op"))]
  | join("+");

# Sorting on the cut address hides which for_each key changed what.
[.resource_changes[]?
 | select(.change.actions != ["no-op"] or .change.importing or .previous_address)
 | (.address | public_address) as $addr
 | {addr: $addr,
    line: ("\(action)\t\($addr)" + (
      if (.change.before | type) == "object" and (.change.after | type) == "object" then
        (.change | changed) as $c
        | (if $c | length > 0 then "\t\($c | join(","))" else "" end)
        + (if (.change.replace_paths // []) | length > 0
           then "\treplaced for: \(.change.replace_paths | map(.[0] | tostring) | unique | join(","))"
           else "" end)
      else "" end)
      + (if .previous_address then "\tfrom: \(.previous_address | public_address)" else "" end))}]
| group_by([.addr, .line])[]
| .[0].line + (if length > 1 then "\t×\(length)" else "" end)
