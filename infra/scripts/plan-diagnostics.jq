# Terraform's errors for plan-dev.yml's public log, read with jq -n -R --arg status <plan exit status>.
# Summaries and details are dropped, since no scrub catches every value from state.
include "public-address" {search: "./"};

def level: if test("^warning$"; "i") then "warning" else "error" end;
# A fixed name, never the text around it, so a maintainer can tell a missing permission from a typo.
def error_class:
  if type == "string" then
    [
      "AccessDeniedException", "AccessDenied", "UnauthorizedOperation",
      "ResourceNotFoundException", "NoSuchEntity", "NotFound",
      "ThrottlingException", "Throttling", "ExpiredToken",
      "InvalidClientTokenId", "ValidationException"
    ] as $names
    | . as $s
    | first($names[] | select(. as $n | $s | test("(?<![A-Za-z0-9])" + $n + "(?![A-Za-z0-9])"))) // "-"
  else "-" end;
# Only a relative .tf path, since a filename comes from Terraform's own message.
def public_file:
  if type == "string" and test("^[A-Za-z0-9_.-][A-Za-z0-9_./-]*\\.tf$") then . else "-" end;
def public_range:
  if type == "object" and (.filename | public_file) != "-" then
    .filename + (if (.start | type) == "object" and (.start.line | type) == "number"
                 then ":\(.start.line | floor)" else "" end)
  else "-" end;

[
  inputs
  | (try fromjson catch null) as $m
  | if ($m | type) == "object" then
      if $m.type == "diagnostic" then
        # One bad diagnostic must not drop the rest.
        try (
          $m.diagnostic
          | [
              (.severity // "" | tostring | level),
              (.address | public_address),
              (.range | public_range),
              (.summary | error_class)
            ]
          | join("\t")
        ) catch "error\t-\t-\t-"
      else empty end
    else
      gsub("\u001b\\[[0-9;]*[A-Za-z]"; "")
      | if test("^(│ )?Error: ") then "error\t-\t-\t-"
        elif test("^(│ )?Warning: ") then "warning\t-\t-\t-"
        else empty end
    end
]
| if length > 0 or (($ARGS.named.status // "0") != "0") then
    .[], "Summaries are withheld from this public log; the last column names the error class. Full text needs a plan run with the plan role's own permissions, such as a maintainer assuming an equivalent read-only role."
  else empty end
